#!/bin/bash
# Worker node bootstrap script.
# Runs via EC2 userdata on ASG launch.
# Pulls configuration from SSM Parameter Store and S3, mounts NFS, runs FIO,
# uploads results to S3, and signals completion.

set -euo pipefail

# Ensure we can resolve public DNS — VPC DHCP may point to internal-only DNS
if ! grep -q "169.254.169.253" /etc/resolv.conf; then
  echo "nameserver 169.254.169.253" | cat - /etc/resolv.conf > /tmp/resolv.conf.new
  cp /tmp/resolv.conf.new /etc/resolv.conf
fi

# IMDSv2 token for metadata access
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
META="curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\""

INSTANCE_ID=$(eval $META http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(eval $META http://169.254.169.254/latest/meta-data/placement/region)
PRIVATE_IP=$(eval $META http://169.254.169.254/latest/meta-data/local-ipv4)

# SSM_PREFIX is set by the launch template userdata environment
SSM_PREFIX="${SSM_PREFIX:-/fio-bench}"

get_param() {
  aws ssm get-parameter --name "${SSM_PREFIX}/$1" --region "$REGION" --query 'Parameter.Value' --output text
}

RUN_ID=$(get_param "current-run-id")
RESULTS_BUCKET=$(get_param "results-bucket")
RESULTS_PREFIX=$(get_param "results-prefix")
MOUNT_COMMAND=$(get_param "mount-command")
STATUS_TABLE=$(get_param "status-table")
MOUNT_POINT=$(echo "$MOUNT_COMMAND" | awk '{print $NF}')

NODE_ID="${INSTANCE_ID}"

log() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $1"
}

# Multi-export mode: try to fetch the mount-commands JSON array.
# If present, we mount multiple exports and distribute FIO jobs across them.
MOUNT_COMMANDS_JSON=$(get_param "mount-commands" 2>/dev/null || echo "")
MULTI_EXPORT=0
declare -a ALL_MOUNT_POINTS=()

if [ -n "$MOUNT_COMMANDS_JSON" ] && [ "$MOUNT_COMMANDS_JSON" != "None" ]; then
  MULTI_EXPORT=1
  # Parse JSON array of mount commands using python (available on AL2023)
  mapfile -t ALL_MOUNT_CMDS < <(echo "$MOUNT_COMMANDS_JSON" | python3 -c "
import sys, json
cmds = json.load(sys.stdin)
for c in cmds:
    print(c)
")
  # Extract mount points (last arg of each command)
  for cmd in "${ALL_MOUNT_CMDS[@]}"; do
    mp=$(echo "$cmd" | awk '{print $NF}')
    ALL_MOUNT_POINTS+=("$mp")
  done
  log "Multi-export mode: ${#ALL_MOUNT_CMDS[@]} exports to mount"
else
  ALL_MOUNT_POINTS=("$MOUNT_POINT")
fi

report_status() {
  local status=$1
  local error=${2:-""}
  aws dynamodb update-item \
    --table-name "$STATUS_TABLE" \
    --key "{\"PK\": {\"S\": \"RUN#${RUN_ID}\"}, \"SK\": {\"S\": \"NODE#${NODE_ID}\"}}" \
    --update-expression "SET #s = :s, privateIp = :ip, instanceId = :iid, updatedAt = :t, #e = :e" \
    --expression-attribute-names '{"#s": "status", "#e": "error"}' \
    --expression-attribute-values "{\":s\": {\"S\": \"${status}\"}, \":ip\": {\"S\": \"${PRIVATE_IP}\"}, \":iid\": {\"S\": \"${INSTANCE_ID}\"}, \":t\": {\"S\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}, \":e\": {\"S\": \"${error}\"}}" \
    --region "$REGION" 2>/dev/null || true
}

# --- Install FIO and NFS utilities ---
log "Installing fio and NFS utilities..."

install_packages() {
  if command -v dnf &>/dev/null; then
    # Amazon Linux 2023 / Fedora / RHEL 9+
    # nfs-utils is available in default repos; fio may not be
    dnf install -y -q nfs-utils

    if ! dnf install -y -q fio 2>/dev/null; then
      log "fio not in default repos, installing from source..."
      install_fio_from_source
    fi

  elif command -v yum &>/dev/null; then
    # Amazon Linux 2 / RHEL 7-8 / CentOS
    yum install -y -q nfs-utils
    if ! yum install -y -q fio 2>/dev/null; then
      # Try enabling EPEL
      yum install -y -q epel-release 2>/dev/null || amazon-linux-extras install epel -y 2>/dev/null || true
      if ! yum install -y -q fio 2>/dev/null; then
        log "fio not available via yum/EPEL, installing from source..."
        install_fio_from_source
      fi
    fi

  elif command -v apt-get &>/dev/null; then
    # Ubuntu / Debian
    apt-get update -qq
    apt-get install -y -qq fio nfs-common

  else
    log "ERROR: No supported package manager found"
    report_status "failed" "No supported package manager (dnf/yum/apt-get)"
    exit 1
  fi
}

install_fio_from_source() {
  log "Building fio from source..."

  # Install build dependencies
  if command -v dnf &>/dev/null; then
    dnf install -y -q gcc make libaio-devel zlib-devel
  elif command -v yum &>/dev/null; then
    yum install -y -q gcc make libaio-devel zlib-devel
  fi

  local FIO_VERSION="3.38"
  local FIO_URL="https://github.com/axboe/fio/archive/refs/tags/fio-${FIO_VERSION}.tar.gz"

  cd /tmp
  curl -sL "$FIO_URL" -o fio.tar.gz
  tar xzf fio.tar.gz
  cd "fio-fio-${FIO_VERSION}"
  ./configure
  make -j"$(nproc)"
  make install
  cd /
  rm -rf /tmp/fio.tar.gz /tmp/fio-fio-${FIO_VERSION}

  log "fio built and installed from source (v${FIO_VERSION})"
}

install_packages

# Verify installations
if ! command -v fio &>/dev/null; then
  log "ERROR: fio is not installed after installation attempt"
  report_status "failed" "fio installation failed"
  exit 1
fi

if ! command -v mount.nfs &>/dev/null && ! command -v mount.nfs4 &>/dev/null; then
  log "ERROR: NFS mount utilities not installed"
  report_status "failed" "NFS utilities (nfs-utils/nfs-common) installation failed"
  exit 1
fi

log "fio version: $(fio --version)"
log "NFS utilities installed: $(which mount.nfs 2>/dev/null || which mount.nfs4 2>/dev/null)"

# --- Mount NFS ---
report_status "mounting"

declare -a WORK_DIRS=()

if [ "$MULTI_EXPORT" -eq 1 ]; then
  log "Mounting ${#ALL_MOUNT_CMDS[@]} NFS exports..."
  for i in "${!ALL_MOUNT_CMDS[@]}"; do
    cmd="${ALL_MOUNT_CMDS[$i]}"
    mp="${ALL_MOUNT_POINTS[$i]}"
    log "Mounting export $((i+1)): $cmd"
    mkdir -p "$mp"

    if ! eval "$cmd"; then
      log "ERROR: NFS mount failed for export $((i+1)): $cmd"
      report_status "failed" "NFS mount failed: $cmd"
      exit 1
    fi

    if ! mountpoint -q "$mp"; then
      log "ERROR: Mount point not active: $mp"
      report_status "failed" "Mount point not active: $mp"
      exit 1
    fi

    # Create per-node working directory on this export
    work_dir="${mp}/fio-bench/${RUN_ID}/${NODE_ID}"
    mkdir -p "$work_dir"
    WORK_DIRS+=("$work_dir")
    log "Export $((i+1)) mounted at $mp, work dir: $work_dir"
  done
else
  log "Mounting NFS (single export): $MOUNT_COMMAND"
  mkdir -p "$MOUNT_POINT"

  if ! eval "$MOUNT_COMMAND"; then
    log "ERROR: NFS mount failed"
    report_status "failed" "NFS mount failed: $MOUNT_COMMAND"
    exit 1
  fi

  if ! mountpoint -q "$MOUNT_POINT"; then
    log "ERROR: Mount point not active after mount command"
    report_status "failed" "Mount point not active: $MOUNT_POINT"
    exit 1
  fi

  # Create per-node working directory
  WORK_DIRS=("${MOUNT_POINT}/fio-bench/${RUN_ID}/${NODE_ID}")
  mkdir -p "${WORK_DIRS[0]}"
fi

log "All NFS exports mounted successfully"
log "Mount details:"
mount | grep -E "$(IFS='|'; echo "${ALL_MOUNT_POINTS[*]}")" || true

# --- Pull FIO job file ---
log "Downloading job file from s3://${RESULTS_BUCKET}/${RESULTS_PREFIX}/job.fio"
aws s3 cp "s3://${RESULTS_BUCKET}/${RESULTS_PREFIX}/job.fio" /tmp/job.fio --region "$REGION"

# --- Assign directories to FIO jobs ---
if [ "$MULTI_EXPORT" -eq 1 ] && [ ${#WORK_DIRS[@]} -gt 1 ]; then
  # Multi-export mode: distribute jobs across work directories (round-robin).
  # Remove ALL directory= lines from the job file (global and per-section).
  # buildMultiExportJobFile() puts placeholder paths that need replacing with
  # actual per-node work directories.
  sed -i '/^directory=/d' /tmp/job.fio

  # Count job sections (lines starting with [ but not [global])
  mapfile -t JOB_SECTIONS < <(grep -n '^\[' /tmp/job.fio | grep -v '\[global\]')
  NUM_JOBS=${#JOB_SECTIONS[@]}
  NUM_EXPORTS=${#WORK_DIRS[@]}

  log "Distributing $NUM_JOBS FIO job(s) across $NUM_EXPORTS exports (round-robin)"

  # For each job section, insert a directory= line pointing to the assigned export
  # Process in reverse order so line numbers don't shift
  for (( i=NUM_JOBS-1; i>=0; i-- )); do
    line_num=$(echo "${JOB_SECTIONS[$i]}" | cut -d: -f1)
    export_idx=$((i % NUM_EXPORTS))
    work_dir="${WORK_DIRS[$export_idx]}"
    # Insert directory= on the line after the section header
    sed -i "${line_num}a directory=${work_dir}" /tmp/job.fio
  done
else
  # Single export mode: all jobs use the same directory
  WORK_DIR="${WORK_DIRS[0]}"
  sed -i "s|^directory=.*|directory=${WORK_DIR}|g" /tmp/job.fio
  if ! grep -q "^directory=" /tmp/job.fio; then
    sed -i "/^\[global\]/a directory=${WORK_DIR}" /tmp/job.fio
  fi
fi

# --- Run FIO ---
report_status "running"
log "Starting FIO benchmark..."
log "Job file contents:"
cat /tmp/job.fio

RESULTS_FILE="/tmp/fio-results.json"

if fio /tmp/job.fio --output="${RESULTS_FILE}" --output-format=json+ --status-interval=5; then
  log "FIO completed successfully"
else
  FIO_EXIT=$?
  log "FIO exited with code $FIO_EXIT"
  report_status "failed" "FIO exited with code $FIO_EXIT"
  # Still upload whatever results we have
fi

# --- Upload results ---
# Disable exit-on-error for uploads — we must always report status even if S3 is flaky
set +e
UPLOAD_FAILED=0

log "Uploading results to S3..."
if [ -f "$RESULTS_FILE" ]; then
  for attempt in 1 2 3; do
    if aws s3 cp "$RESULTS_FILE" \
      "s3://${RESULTS_BUCKET}/${RESULTS_PREFIX}/${NODE_ID}.json" \
      --region "$REGION" 2>&1; then
      log "Results uploaded successfully"
      break
    else
      log "Upload attempt $attempt failed, retrying in 5s..."
      sleep 5
      if [ "$attempt" -eq 3 ]; then
        log "ERROR: Failed to upload results after 3 attempts"
        UPLOAD_FAILED=1
      fi
    fi
  done
fi

# Upload FIO time-series logs if they exist (best-effort, no retry)
for logfile in /tmp/*.log; do
  [ -f "$logfile" ] || continue
  aws s3 cp "$logfile" \
    "s3://${RESULTS_BUCKET}/${RESULTS_PREFIX}/logs/${NODE_ID}/$(basename "$logfile")" \
    --region "$REGION" 2>/dev/null || true
done

# Re-enable exit-on-error
set -e

# --- Cleanup ---
log "Cleaning up test files..."
for wd in "${WORK_DIRS[@]}"; do
  rm -rf "$wd"
done

log "Unmounting NFS..."
for mp in "${ALL_MOUNT_POINTS[@]}"; do
  umount "$mp" 2>/dev/null || true
done

# Always report final status regardless of upload success
if [ "$UPLOAD_FAILED" -eq 1 ]; then
  report_status "completed" "FIO completed but result upload to S3 failed"
else
  report_status "completed"
fi
log "Worker complete."
