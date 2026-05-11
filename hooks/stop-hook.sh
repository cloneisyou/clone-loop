#!/bin/bash

# Clone Loop Stop Hook.
# Blocks session exit while a Clone Loop is active, calls Clone MCP directly,
# and feeds Claude the prediction when it clears the user's confidence threshold.

set -euo pipefail

HOOK_INPUT=$(cat)
LOOP_STATE_FILE=".claude/clone-loop.local.md"

json_field() {
  local field="$1"
  node -e '
const field = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const normalized = input.replace(/^\uFEFF/, "").trim();
    const parsed = normalized ? JSON.parse(normalized) : {};
    const value = parsed[field];
    process.stdout.write(value == null ? "" : String(value));
  } catch {
    process.exit(1);
  }
});
' "$field"
}

last_assistant_text() {
  node -e '
const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
const lines = input.split(/\r?\n/).filter(Boolean);
const texts = [];
for (const line of lines) {
  const parsed = JSON.parse(line.replace(/^\uFEFF/, ""));
  const content = parsed.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block?.type === "text") texts.push(block.text || "");
  }
}
process.stdout.write(texts.at(-1) || "");
'
}

json_block_response() {
  STOP_PROMPT="$1" STOP_MSG="$2" node -e '
console.log(JSON.stringify({
  decision: "block",
  reason: process.env.STOP_PROMPT || "",
  systemMessage: process.env.STOP_MSG || "",
}, null, 2));
'
}

confidence_clears_threshold() {
  node -e '
const confidence = Number(process.argv[1]);
const threshold = Number(process.argv[2]);
process.exit(Number.isFinite(confidence) && Number.isFinite(threshold) && confidence >= threshold ? 0 : 1);
' "$1" "$2"
}

clone_predict_next_prompt() {
  CLONE_AGENT_ENV="$1" \
  CLONE_AGENT_INPUT_ENV="$2" \
  CLONE_K_ENV="$3" \
  CLONE_THRESHOLD_ENV="$4" \
  CLONE_SESSION_ENV="$5" \
  CLONE_ENDPOINT_ENV="${CLONE_MCP_URL:-https://api.clone.is/mcp}" \
  CLONE_TOKEN_ENV="${CLONE_API_TOKEN:-}" \
  node -e '
const endpoint = process.env.CLONE_ENDPOINT_ENV;
const token = process.env.CLONE_TOKEN_ENV;

if (!token) {
  console.error("CLONE_API_TOKEN is required for Clone Loop v2.");
  process.exit(1);
}

function parseRpcText(text) {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  return JSON.parse(data || text);
}

async function rpc(method, params = {}, sessionId = "") {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Clone-API-Key": token,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Clone MCP ${method} failed with HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return {
    sessionId: res.headers.get("mcp-session-id") || sessionId,
    payload: text ? parseRpcText(text) : null,
  };
}

(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "clone-claude-plugin", version: "0.2.2" },
  });

  const args = {
    agent: process.env.CLONE_AGENT_ENV,
    agent_input: process.env.CLONE_AGENT_INPUT_ENV,
    k: Number(process.env.CLONE_K_ENV || "1"),
    threshold: Number(process.env.CLONE_THRESHOLD_ENV || "0.8"),
  };
  if (process.env.CLONE_SESSION_ENV) args.session_id = process.env.CLONE_SESSION_ENV;

  const prediction = await rpc(
    "tools/call",
    { name: "predict_next_prompt", arguments: args },
    init.sessionId,
  );
  const content = prediction.payload?.result?.content?.[0];
  if (!content || content.type !== "text") {
    throw new Error("Clone MCP returned no text prediction content.");
  }
  process.stdout.write(JSON.stringify(JSON.parse(content.text)));
})().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
'
}

if [[ ! -f "$LOOP_STATE_FILE" ]]; then
  exit 0
fi

FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$LOOP_STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\(.*\)"$/\1/')
CLONE_THRESHOLD=$(echo "$FRONTMATTER" | grep '^clone_threshold:' | sed 's/clone_threshold: *//' || true)
CLONE_K=$(echo "$FRONTMATTER" | grep '^clone_k:' | sed 's/clone_k: *//' || true)
CLONE_AGENT=$(echo "$FRONTMATTER" | grep '^clone_agent:' | sed 's/clone_agent: *//' | sed 's/^"\(.*\)"$/\1/' || true)

CLONE_THRESHOLD="${CLONE_THRESHOLD:-0.8}"
CLONE_K="${CLONE_K:-1}"
CLONE_AGENT="${CLONE_AGENT:-Claude Code Clone Loop}"

STATE_SESSION=$(echo "$FRONTMATTER" | grep '^session_id:' | sed 's/session_id: *//' || true)
HOOK_SESSION=$(printf '%s' "$HOOK_INPUT" | json_field session_id)
if [[ -n "$STATE_SESSION" ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "Clone Loop: state file corrupted; iteration is not numeric." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Clone Loop: state file corrupted; max_iterations is not numeric." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ ! "$CLONE_K" =~ ^[0-9]+$ ]] || [[ "$CLONE_K" -lt 1 ]] || [[ "$CLONE_K" -gt 10 ]]; then
  echo "Clone Loop: state file corrupted; clone_k must be 1-10." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "Clone Loop: Max iterations ($MAX_ITERATIONS) reached."
  rm "$LOOP_STATE_FILE"
  exit 0
fi

HOOK_LAST_MESSAGE=$(printf '%s' "$HOOK_INPUT" | json_field last_assistant_message)
LAST_OUTPUT="$HOOK_LAST_MESSAGE"

if [[ -z "$LAST_OUTPUT" ]]; then
  TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | json_field transcript_path)
  if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    echo "Clone Loop: Transcript file not found; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  if ! grep -q '"role":"assistant"' "$TRANSCRIPT_PATH"; then
    echo "Clone Loop: No assistant messages found; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  LAST_LINES=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" | tail -n 100)
  if [[ -z "$LAST_LINES" ]]; then
    echo "Clone Loop: Failed to extract assistant messages; stopping." >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi

  set +e
  LAST_OUTPUT=$(printf '%s' "$LAST_LINES" | last_assistant_text 2>&1)
  JSON_EXIT=$?
  set -e

  if [[ $JSON_EXIT -ne 0 ]]; then
    echo "Clone Loop: Failed to parse assistant message JSON." >&2
    echo "Error: $LAST_OUTPUT" >&2
    rm "$LOOP_STATE_FILE"
    exit 0
  fi
fi

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")
  if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
    echo "Clone Loop: Detected <promise>$COMPLETION_PROMISE</promise>"
    rm "$LOOP_STATE_FILE"
    exit 0
  fi
fi

NEXT_ITERATION=$((ITERATION + 1))

PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$LOOP_STATE_FILE")
if [[ -z "$PROMPT_TEXT" ]]; then
  echo "Clone Loop: State file has no prompt text; stopping." >&2
  rm "$LOOP_STATE_FILE"
  exit 0
fi

TEMP_FILE="${LOOP_STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$LOOP_STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$LOOP_STATE_FILE"

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
  SYSTEM_MSG="Clone Loop iteration $NEXT_ITERATION | To stop: output <promise>$COMPLETION_PROMISE</promise> only when true."
else
  SYSTEM_MSG="Clone Loop iteration $NEXT_ITERATION | No completion promise set."
fi

AGENT_INPUT=$(cat <<EOF
Original Clone Loop prompt:
$PROMPT_TEXT

Clone Loop iteration: $NEXT_ITERATION
Clone threshold: $CLONE_THRESHOLD

Claude last_assistant_message:
$LAST_OUTPUT
EOF
)

set +e
PREDICTION_JSON=$(clone_predict_next_prompt "$CLONE_AGENT" "$AGENT_INPUT" "$CLONE_K" "$CLONE_THRESHOLD" "$HOOK_SESSION" 2>&1)
PREDICTION_EXIT=$?
set -e

if [[ $PREDICTION_EXIT -ne 0 ]]; then
  rm "$LOOP_STATE_FILE"
  ESCALATION_PROMPT=$(cat <<EOF
Clone Loop requires human escalation.

Clone MCP failed while predicting the next user prompt:
$PREDICTION_JSON

The loop state file has been removed. Tell the user Clone could not produce a safe automatic continuation and wait for human input.
EOF
)
  json_block_response "$ESCALATION_PROMPT" "Clone Loop stopped because Clone MCP failed."
  exit 0
fi

PREDICTION_ID=$(printf '%s' "$PREDICTION_JSON" | json_field id)
PREDICTED_STATUS=$(printf '%s' "$PREDICTION_JSON" | json_field status)
PREDICTED_RESPONSE=$(printf '%s' "$PREDICTION_JSON" | json_field predicted_response)
PREDICTED_CONFIDENCE=$(printf '%s' "$PREDICTION_JSON" | json_field confidence)
PREDICTED_REASONING=$(printf '%s' "$PREDICTION_JSON" | json_field reasoning)

CONTINUATION_PROMPT=$(cat <<EOF
You are continuing a Clone Loop.

Clone predicted the user's next prompt with confidence $PREDICTED_CONFIDENCE:

$PREDICTED_RESPONSE

The user-configured confidence threshold ($CLONE_THRESHOLD) was met. Evaluate
the prediction in context, then continue as if the user had provided the
predicted prompt when it is consistent with the current task state.
Prediction status: $PREDICTED_STATUS
Prediction id: $PREDICTION_ID
Prediction reasoning: $PREDICTED_REASONING

Keep the Clone Loop completion promise rule: only output <promise>$COMPLETION_PROMISE</promise> when it is genuinely true.
EOF
)

if [[ -z "$PREDICTED_RESPONSE" ]] || [[ -z "$PREDICTED_CONFIDENCE" ]]; then
  rm "$LOOP_STATE_FILE"
  json_block_response "Clone Loop requires human escalation. Clone MCP returned an incomplete prediction, so the loop state file has been removed. Tell the user Clone was not confident enough and wait for human input." "Clone Loop stopped because Clone returned an incomplete prediction."
  exit 0
fi

if confidence_clears_threshold "$PREDICTED_CONFIDENCE" "$CLONE_THRESHOLD"; then
  json_block_response "$CONTINUATION_PROMPT" "$SYSTEM_MSG"
  exit 0
fi

rm "$LOOP_STATE_FILE"
ESCALATION_PROMPT=$(cat <<EOF
Clone Loop requires human escalation.

Clone was not confident enough to continue automatically.
- status: $PREDICTED_STATUS
- confidence: $PREDICTED_CONFIDENCE
- threshold: $CLONE_THRESHOLD
- predicted_response: $PREDICTED_RESPONSE

The loop state file has been removed. Tell the user Clone was not confident enough and wait for human input.
EOF
)

json_block_response "$ESCALATION_PROMPT" "Clone Loop stopped because Clone confidence was below threshold."

exit 0
