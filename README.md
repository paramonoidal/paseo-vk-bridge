# paseo-vk-bridge

Talk to the [Paseo](https://paseo.sh) agents on your machines from a personal VK chat. Send a message to your VK community and the bridge passes it to an agent on the node you picked. The agent's messages come back as they are written, with one-line titles for the actions it took in between, the way the Codex app shows a turn:

```
📄 Read conversation-list.tsx
🔍 Searched for “scrollToEnd”

Now I have a clearer picture. The auto-scroll uses a ref on the FlatList…

✏️ Edited use-scroll-anchor.ts
💻 Ran node scripts/simulate-stream-burst.mjs

The change keeps scroll-to-bottom working when you are at the bottom…

✅ Done in 7m 8s · 1 file changed +2 −1
```

Tool output never reaches the chat. Photos and documents go to the agent, and voice messages are transcribed by the bridge.

The bridge is a standalone Paseo client built on the public SDK (`@getpaseo/client`). It needs no change to Paseo, no plugin, and no Hub.

## How it works

```
VK DM ⇄ VK Bots Long Poll ⇄ paseo-vk-bridge
                               ├─ relay (end-to-end encrypted) ─ node A daemon
                               ├─ relay (end-to-end encrypted) ─ node B daemon
                               └─ ws://127.0.0.1:6767 ─ local daemon
```

- Every connection is outbound. The bridge polls VK and connects to each daemon the way the Paseo phone app does, so nodes need no open ports.
- The bridge is the owner of every node it connects to. Agents start in their provider's full-access mode (`bypassPermissions` for Claude Code, `full-access` for Codex), so they run without stopping for approval.
- Incoming VK events are journaled with the Long Poll cursor before they are handled, so a restart neither drops nor repeats a message. A message caught mid-dispatch is reported instead of being sent twice.
- The bridge saves its position in each agent's timeline. After a reconnect or a restart, the chat catches up on what it missed.

## Set up the VK community

1. Create a community for the bot. It can be private.
2. In **Manage → Messages**, turn community messages on. In **Bot settings**, turn bot capabilities on.
3. In **Manage → API usage → Access tokens**, create a token with access to community messages and community management. The management scope lets the bridge turn on Long Poll for `message_new` itself. Without it, turn on **Long Poll API** (version 5.199, event *Incoming message*) by hand.
4. Note the community ID: the number in `club123456789`.
5. Write any message to the community from your account. The bridge answers people outside the allowlist with their numeric VK ID, so this is also how you find yours.

## Connect your nodes

Each node is a machine running the Paseo daemon.

| Where the node is | Config |
| --- | --- |
| Anywhere, through the Paseo relay | Run `paseo daemon pair` on the node and set `"pairing"` to the link it prints. |
| On your tailnet or LAN | `"url": "100.64.0.2:6767"`, plus `"password"` if the daemon has one. |
| On the bridge's machine | `"url": "127.0.0.1:6767"`. If the daemon has a password, set `"localCredentialFile": "/home/me/.paseo/local-credential"` instead of copying it. |

## Configure

Copy `config.example.json` to `config.json`. `${NAME}` in any string is replaced with that environment variable, so secrets can stay in `.env`.

| Field | Default | Meaning |
| --- | --- | --- |
| `vk.token` | — | Community token. |
| `vk.groupId` | — | Community ID. |
| `vk.allowlist` | — | Numeric VK user IDs allowed to use the bridge. Everyone else is turned away. |
| `vk.textChunkLimit` | `4000` | Longer messages are split, preferring paragraph breaks. |
| `vk.attachmentLimitMb` | `25` | Largest photo, document or voice message the bridge downloads. |
| `nodes.<name>.pairing` / `.url` | — | How to reach the node. Set exactly one. |
| `nodes.<name>.password` | — | Daemon password, for a direct connection. |
| `nodes.<name>.cwd` | — | Where the first agent starts when you just send a message. |
| `nodes.<name>.provider` | `defaults.provider` | Provider for new agents on this node. |
| `defaults.node` | first node | Node a new chat starts on. |
| `defaults.provider` | `codex` | `codex`, `claude`, any provider ID the node offers, or `provider/model`. Without a model, the node's default model is used. |
| `defaults.modes` | full access | Mode per provider, e.g. `{ "claude": "acceptEdits" }`. |
| `defaults.busy` | `steer` | A message sent while the agent works: `steer` adds it to the current turn, `interrupt` stops the turn and starts a new one. |
| `feed.actions` | `true` | Show action titles between the agent's messages. |
| `feed.flushAfterSeconds` | `45` | During a long run of tool calls, post the titles collected so far after this long. |
| `transcription` | `{ "kind": "none" }` | See [Voice messages](#voice-messages). |
| `stateFile` | `paseo-vk-bridge.state.json` | Long Poll cursor, inbox journal, chat bindings and timeline positions. Relative to the config file. |
| `logLevel` | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr. |

## Run

```sh
npm ci
npm run build
node dist/main.js --config config.json --check   # verifies the VK token and every node
node dist/main.js --config config.json
```

`deploy/paseo-vk-bridge.service` is a systemd unit for `/opt/paseo-vk-bridge`. On `SIGTERM` the bridge posts pending output and saves its state before exiting.

## Use it from VK

Send a message to start an agent in the node's `cwd`, or pick a project first.

| Command | Does |
| --- | --- |
| `/nodes`, `/node <name>` | List nodes with their status, or switch node. Each node keeps its own agent for the chat. |
| `/projects` | List the node's projects. |
| `/new [provider] [n \| /path]` | Start a new agent, optionally with another provider, in project `n` from `/projects` or in a path. |
| `/agents`, `/use <n \| id>` | List recent agents on the node, including ones started in the Paseo app, or switch to one. Switching shows its last message. |
| `/stop` | Stop the current turn. |
| `/status` | Node, agent, model, mode, directory and how long the turn has run. |
| `/mode [id]`, `/model [id]` | Show or change the agent's mode or model. |
| `/allow [n]`, `/deny [reason]` | Answer a pending request. |
| `/archive` | Archive the agent. The next message starts a new one. |

Messages that start with `//` go to the agent as slash commands: `//compact` sends `/compact`.

Questions from the agent arrive with numbered options and buttons. Reply with a number, several numbers for a multi-select question, your own text, or one line per question when there are several. Plan approvals and any other request take a number, `/allow`, or `/deny <reason>`. Free text on a request declines it and passes your text to the agent.

Messages typed in the Paseo app while the chat follows the same agent are shown with 👤.

## Voice messages

The bridge downloads the voice message, transcribes it, shows you the text (`🎤 …`) and sends it to the agent.

Any server with the OpenAI transcription API works:

```json
"transcription": { "kind": "openai", "apiKey": "${OPENAI_API_KEY}", "model": "whisper-1", "language": "ru" }
```

```json
"transcription": {
  "kind": "openai",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKey": "${GROQ_API_KEY}",
  "model": "whisper-large-v3"
}
```

To keep audio on your machine, run a local program. `{file}` becomes the path of the downloaded OGG/Opus file, and whatever the program prints is the transcript:

```json
"transcription": { "kind": "command", "command": ["/opt/whisper/transcribe.sh", "{file}"] }
```

```sh
#!/bin/sh
# whisper.cpp wants 16 kHz WAV.
set -e
wav="$(mktemp --suffix=.wav)"
trap 'rm -f "$wav"' EXIT
ffmpeg -loglevel error -y -i "$1" -ar 16000 -ac 1 "$wav"
whisper-cli -m /opt/whisper/ggml-small.bin -l ru -nt -np -f "$wav"
```

With `"kind": "none"`, the bridge uses VK's own transcript when the community has one, and otherwise asks you to configure transcription.

## Security

- Whoever controls an allowlisted VK account can run agents with full access on every configured node. Keep the allowlist to your own ID and protect that account.
- VK messages are not end-to-end encrypted. Your prompts and the agents' messages are stored by VK. Tool output, diffs and files stay on the nodes; only action titles are posted.
- The relay connection to each node is end-to-end encrypted with the daemon's key from the pairing link. Treat pairing links and `config.json` as secrets.
- The bridge downloads attachments only from VK hosts over HTTPS and never logs the VK token.

## Development

```sh
npm test            # unit tests
npm run typecheck
npm run format
```

The end-to-end suite drives the real bridge against a real Paseo daemon and a fake VK server. `scripts/dev-daemon.sh` starts an isolated daemon in development mode, whose `mock` provider streams a scripted agent turn without credentials:

```sh
eval "$(scripts/dev-daemon.sh)"
PASEO_E2E_DAEMON=$PASEO_E2E_DAEMON PASEO_E2E_CWD=$PASEO_E2E_CWD npm run test:e2e
```
