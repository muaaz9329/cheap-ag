#!/bin/zsh
# Side-by-side check on your own project: the same prompt, once in plain Claude Code and once with cheapag.
#   bench/compare.sh setup <project-dir>            two copies of the project at its last commit: <dir>-stock, <dir>-cheapag
#   bench/compare.sh run <project-dir> "<prompt>"   runs both in parallel and prints Opus/Sonnet tokens and cost per arm
# Both copies run with bypassPermissions (no prompts), so only point this at a project you trust.
set -e
cmd=$1; dir=${2:A}; prompt=$3
stock=$dir-stock; cheap=$dir-cheapag; cli=${0:A:h:h}/dist/index.js

if [[ $cmd == setup ]]; then
  # cheapag and the copies need git: a folder without a repo starts one, committing what is there
  if ! git -C $dir rev-parse --git-dir >/dev/null 2>&1; then
    git -C $dir init -q && git -C $dir add -A && git -C $dir commit -q --allow-empty -m "start"
    echo "Started a git repo in $dir"
  fi
  git -C $dir worktree add -q --detach $stock HEAD
  git -C $dir worktree add -q --detach $cheap HEAD
  echo "Copies made (uncommitted changes in $dir are not in them):"
  echo "  $stock"
  echo "  $cheap"
  echo "Now give cheapag your consent for the cheapag copy (only you can):"
  echo "  cd $cheap && node $cli allow"
  exit 0
fi

[[ $cmd == run && -n $prompt ]] || { echo 'usage: bench/compare.sh setup <dir> | run <dir> "<prompt>"'; exit 1; }
# without consent every delegate returns CONSENT and Claude does the work itself: the run would compare Claude with Claude
[[ -f $cheap/.cheapag/consent.json ]] || { echo "No cheapag consent in $cheap yet. Run first:"; echo "  cd $cheap && node $cli allow"; exit 1; }
# each run starts both copies from the project's latest commit (cheapag's consent and logs in .cheapag are kept)
head=$(git -C $dir rev-parse HEAD)
for arm in $stock $cheap; do git -C $arm reset -q --hard $head && git -C $arm clean -fdq -e .cheapag; done
base=(-p $prompt --model claude-opus-5-5 --permission-mode bypassPermissions --output-format json)
# no cheapag server, plugin or context in the stock arm (checked: no cheapag tools, no "Cheap Agent" in context)
(cd $stock && claude $base --strict-mcp-config --mcp-config '{"mcpServers":{}}' --settings '{"enabledPlugins":{"cheapag@cheapag-dev":false}}' > .compare.json 2> .compare.err) &
# the cheapag arm gets only the cheapag server too, so your other MCP servers (and their ~11k tokens a turn) are in neither arm
(cd $cheap && claude $base --strict-mcp-config --mcp-config "{\"mcpServers\":{\"cheapag\":{\"command\":\"${commands[node]}\",\"args\":[\"$cli\"]}}}" > .compare.json 2> .compare.err) &
wait

for arm in $stock $cheap; do
  node -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1] + "/.compare.json", "utf8"));
    const fam = (re) => Object.entries(o.modelUsage ?? {}).filter(([m]) => re.test(m)).map(([, u]) => u);
    const tok = (us) => us.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
    const usd = (us) => us.reduce((n, u) => n + u.costUSD, 0);
    const k = (n) => Math.round(n / 1000) + "k";
    console.log(`${process.argv[1].endsWith("-stock") ? "stock  " : "cheapag"}  opus ${k(tok(fam(/opus/)))} ($${usd(fam(/opus/)).toFixed(2)})  sonnet ${k(tok(fam(/sonnet/)))} ($${usd(fam(/sonnet/)).toFixed(2)})  turns ${o.num_turns}  ${Math.round(o.duration_ms / 60000)} min`);
  ' $arm
  git -C $arm diff --stat | tail -1
done
echo "Answers: $stock/.compare.json and $cheap/.compare.json (field \"result\"); check each diff with: git -C <copy> diff"
