#!/usr/bin/env bash
# VOID CLIENT autopilot: nightly maintenance loop.
# 1) health-checks the ecosystem endpoints, alerts via issue if broken
# 2) auto-ships a release when mc-launcher/package.json version is unreleased
set -euo pipefail
cd "${GITHUB_WORKSPACE:-$(pwd)}"
REPO="${GITHUB_REPOSITORY:-Markipler609/VoidClient}"
note() { echo "[autopilot] $*"; }
warn() { echo "[autopilot][WARN] $*"; }

git fetch --tags --force origin main 2>/dev/null || true

# ---------- 1. health checks ----------
ok=1
check() {
  local name="$1" url="$2" expect="$3"
  local code
  code=$(curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VOIDClientAutopilot/1.0" -o /tmp/autopilot_body -w "%{http_code}" --max-time 20 "$url" || echo 000)
  if [ "$code" = "$expect" ]; then
    echo "  health[OK]   $name -> HTTP $code"
  elif [ "$code" = "403" ]; then
    echo "  health[WARN] $name -> HTTP 403 (host blocks CI datacenter IPs; not an outage)"
  else
    echo "  health[FAIL] $name -> HTTP $code (expected $expect)"
    ok=0
  fi
}
check counter   "http://x95027pc.beget.tech/counter.php"                         200
check site      "http://x95027pc.beget.tech/"                                   200
check telemetry "http://x95027pc.beget.tech/api/telemetry.php?health=1"          200
check stats401  "http://x95027pc.beget.tech/api/stats.php"                      401
check pages     "https://markipler609.github.io/VoidClient/version.json"        200
check feed      "https://markipler609.github.io/VoidClient/feed.xml"            200

marker="$GITHUB_WORKSPACE/.autopilot/.unhealthy"
mkdir -p "$(dirname "$marker")"
if [ "$ok" -eq 1 ]; then
  rm -f "$marker"
  echo "  health: all endpoints OK"
else
  if [ ! -f "$marker" ]; then
    echo "unhealthy" > "$marker"
    gh issue create --repo "$REPO" --title "Autopilot: ecosystem health check failed" \
      --body "One or more endpoints did not answer as expected. Inspect the latest autopilot run logs." || warn "could not create issue"
  else
    warn "still unhealthy since previous run — issue not re-created"
  fi
fi

# ---------- 2. auto-release if a new version is ready ----------
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
note "latest tag: ${LATEST_TAG:-<none>}"
PKG_VER=$(grep -m1 '"version"' mc-launcher/package.json | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || echo "")
note "mc-launcher/package.json version: ${PKG_VER:-<none>}"

if [ -n "$PKG_VER" ] && [ "v$PKG_VER" != "$LATEST_TAG" ]; then
  note "shipping v$PKG_VER ..."
  git tag -f "v$PKG_VER"
  git push origin "v$PKG_VER" 2>&1 | sed 's/^/  /'
  # wait for the build workflow (win+linux+mac x4)
  RELEASE_OK=1
  FOUND=0
  for i in $(seq 1 60); do
    sleep 20
    RUN=$(gh run list --workflow=build --event push --limit 40 --json databaseId,headBranch,status,conclusion --jq \
      ".[] | select(.headBranch == \"v$PKG_VER\") | select(.status == \"completed\") | ." 2>/dev/null || echo "")
    if [ -n "$RUN" ]; then
      FOUND=1
      echo "$RUN" | grep -q '"conclusion": "success"' || RELEASE_OK=0
      break
    fi
  done
  if [ "$FOUND" -ne 1 ]; then warn "build workflow did not finish in time"; RELEASE_OK=0; fi
  if [ "$RELEASE_OK" -ne 1 ]; then
    warn "release build failed — leaving manifest untouched"
    gh issue create --repo "$REPO" --title "Autopilot: release build for v$PKG_VER failed" \
      --body "The build workflow did not complete successfully for tag v$PKG_VER. Check Actions." || true
    exit 0
  fi

  cd "${GITHUB_WORKSPACE}"
  DL=/tmp/void_release
  rm -rf "$DL"; mkdir -p "$DL"
  gh release download "v$PKG_VER" -D "$DL" --clobber
  SHA() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || echo ""; }
  H_INST=$(SHA "$DL/VOID_Client_Setup_$PKG_VER.exe")
  H_PORT=$(SHA "$DL/VOID_Launcher.exe")
  H_LIN=$(SHA "$DL/void-client-$PKG_VER.tar.gz")
  H_X64=$(SHA "$DL/VOID_Client_$PKG_VER-x64.dmg")
  H_ARM=$(SHA "$DL/VOID_Client_$PKG_VER-arm64.dmg")
  note "sha256 computed: install=${H_INST:0:8} portable=${H_PORT:0:8} linux=${H_LIN:0:8} mac64=${H_X64:0:8} macarm=${H_ARM:0:8}"
  SUBJ=$(git log -1 --format=%s "v$PKG_VER" 2>/dev/null | head -c 200 || echo "new release")

  python3 - "$PKG_VER" "$H_INST" "$H_PORT" "$H_LIN" "$H_X64" "$H_ARM" "$SUBJ" <<'PY'
import json, sys, datetime
ver, h_inst, h_port, h_lin, h_x64, h_arm, subj = sys.argv[1:]
base = "https://github.com/Markipler609/VoidClient/releases/download/v" + ver
m = "docs/version.json"
d = json.load(open(m, encoding="utf-8"))
d["version"] = ver
d["date"] = datetime.date.today().isoformat()
d["downloads"] = {
  "win_installer": {"url": base + "/VOID_Client_Setup_" + ver + ".exe",                  "sha256": h_inst},
  "win_portable":  {"url": base + "/VOID_Launcher.exe",                                  "sha256": h_port},
  "linux":         {"url": base + "/void-client-" + ver + ".tar.gz",                     "sha256": h_lin},
  "mac_x64":       {"url": base + "/VOID_Client_" + ver + "-x64.dmg",                    "sha256": h_x64},
  "mac_arm64":     {"url": base + "/VOID_Client_" + ver + "-arm64.dmg",                  "sha256": h_arm},
}
notice = {"id": "v" + ver.replace(".", ""), "title": "VOID CLIENT " + ver, "body": subj}
if not any(n.get("id") == notice["id"] for n in d.get("notices", [])):
    d.setdefault("notices", []).insert(0, notice)
open(m, "w", encoding="utf-8").write(json.dumps(d, indent=4, ensure_ascii=False) + "\n")
print("version.json ->", ver)
PY

  feed="docs/feed.xml"
  TODAY=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ENTRY=$(cat <<EOF
  <entry>
    <title>v$PKG_VER — autopilot release</title>
    <id>https://github.com/$REPO/releases/tag/v$PKG_VER</id>
    <link href="https://github.com/$REPO/releases/tag/v$PKG_VER" />
    <updated>$TODAY</updated>
    <summary>$SUBJ</summary>
  </entry>
EOF
)
  python3 - "$ENTRY" <<'PY'
import sys
entry = sys.argv[1]
p = "docs/feed.xml"
s = open(p, encoding="utf-8").read()
s = s.replace("  <author>", entry + "\n  <author>", 1)
open(p, "w", encoding="utf-8").write(s)
print("feed.xml updated")
PY

  # changelog
  CHG="CHANGELOG.md"
  if [ -f "$CHG" ]; then
    DD=$(date -u +%Y-%m-%d)
    python3 - "$PKG_VER" "$DD" "$SUBJ" <<'PY'
import sys
ver, dd, subj = sys.argv[1:]
p = "CHANGELOG.md"
s = open(p, encoding="utf-8").read()
head = f"## [{ver}] — {dd}\n\n### Changed\n\n- Autopilot release: {subj}\n\n"
s = s.replace("All notable changes to VOID CLIENT.", "All notable changes to VOID CLIENT.\n\n" + head, 1)
open(p, "w", encoding="utf-8").write(s)
print("CHANGELOG.md updated")
PY
  fi

  # keep mirrors in sync
  cp docs/version.json website/version.json 2>/dev/null || true
  cp docs/feed.xml website/feed.xml 2>/dev/null || true
  git add docs/version.json docs/feed.xml CHANGELOG.md website/version.json website/feed.xml
  git -c user.name="VOID Autopilot" -c user.email="autopilot@users.noreply.github.com" \
      commit -m "autopilot: ship v$PKG_VER (manifest hashes + feed + changelog)" 2>&1 | sed 's/^/  /'
  git push origin main 2>&1 | sed 's/^/  /'
  note "release v$PKG_VER shipped"

  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    python3 - "$PKG_VER" "$SUBJ" <<'PY' > /tmp/discord_payload.json
import json, sys
ver, subj = sys.argv[1], sys.argv[2][:500]
print(json.dumps({
    "content": f"🚀 **VOID CLIENT {ver} is here!**",
    "embeds": [{
        "title": "VOID CLIENT " + ver,
        "url": "https://github.com/Markipler609/VoidClient/releases/tag/v" + ver,
        "description": subj or "New release available. Grab it from the download page or let the launcher update itself.",
        "color": 16750080,
    }],
}, ensure_ascii=False))
PY
    curl -s -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" -H "Content-Type: application/json" --data @/tmp/discord_payload.json && echo "  discord announce sent" || warn "discord webhook announce failed"
  else
    warn "DISCORD_WEBHOOK_URL not set — skipping Discord announcement"
  fi
else
  note "no unreleased version in mc-launcher/package.json — nothing to ship"
fi

echo "[autopilot] done"