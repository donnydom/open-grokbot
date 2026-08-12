/** Embedded single-page UI for the console. Zero build step: one HTML
 * string with inline CSS/JS; talks to the console API + SSE live feed. */

export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open-Grokbot Console</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font-family: ui-monospace, Consolas, monospace; background:#0d1117; color:#c9d1d9; }
  header { padding:10px 16px; border-bottom:1px solid #30363d; display:flex; gap:12px; align-items:center; }
  header h1 { font-size:16px; margin:0; }
  main { display:flex; height:calc(100vh - 49px); }
  aside { width:220px; border-right:1px solid #30363d; padding:12px; overflow-y:auto; }
  aside h2 { font-size:13px; color:#8b949e; margin:0 0 8px; }
  .agent { padding:8px; margin-bottom:6px; border:1px solid #30363d; border-radius:6px; cursor:pointer; }
  .agent.active { border-color:#58a6ff; background:#161b22; }
  .agent .name { font-weight:600; }
  .agent .meta { font-size:11px; color:#8b949e; }
  section { flex:1; display:flex; flex-direction:column; }
  #feed { flex:1; overflow-y:auto; padding:16px; }
  .msg { margin-bottom:10px; max-width:80%; }
  .msg .who { font-size:11px; color:#8b949e; }
  .msg.user .who { color:#58a6ff; }
  .msg.agent .who { color:#3fb950; }
  .msg .body { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:8px 12px; white-space:pre-wrap; }
  #composer { display:flex; gap:8px; padding:12px; border-top:1px solid #30363d; }
  #input { flex:1; background:#0d1117; border:1px solid #30363d; border-radius:6px; color:#c9d1d9; padding:8px; font-family:inherit; }
  button { background:#21262d; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:8px 14px; cursor:pointer; }
  button:hover { background:#30363d; }
  #status { font-size:12px; color:#8b949e; padding:0 16px 8px; }
</style>
</head>
<body>
<header>
  <h1>Open-Grokbot Console</h1>
  <button id="broadcast">Broadcast</button>
  <button id="group">Group chat</button>
  <span id="status">connecting…</span>
</header>
<main>
  <aside>
    <h2>Agents</h2>
    <div id="agents"></div>
  </aside>
  <section>
    <div id="feed"></div>
    <div id="composer">
      <input id="input" placeholder="Send a message…" autocomplete="off">
      <button id="send">Send</button>
    </div>
  </section>
</main>
<script>
const state = { agents: [], active: null };
const feed = document.getElementById('feed');
const input = document.getElementById('input');
const status = document.getElementById('status');

function addMessage(agentId, who, text) {
  if (state.active && agentId !== state.active) return;
  const div = document.createElement('div');
  div.className = 'msg ' + (who === 'user' ? 'user' : 'agent');
  const w = document.createElement('div'); w.className = 'who'; w.textContent = who;
  const b = document.createElement('div'); b.className = 'body'; b.textContent = text;
  div.append(w, b); feed.append(div); feed.scrollTop = feed.scrollHeight;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadAgents() {
  const agents = await api('/api/agents');
  state.agents = agents;
  const box = document.getElementById('agents'); box.textContent = '';
  for (const agent of agents) {
    const div = document.createElement('div');
    div.className = 'agent' + (state.active === agent.id ? ' active' : '');
    const n = document.createElement('div'); n.className = 'name'; n.textContent = agent.name;
    const m = document.createElement('div'); m.className = 'meta'; m.textContent = agent.isGroup ? 'group' : agent.id;
    div.append(n, m);
    div.onclick = async () => {
      state.active = agent.id;
      feed.textContent = '';
      const t = await api('/api/transcript?agent=' + encodeURIComponent(agent.id));
      for (const e of t.entries) {
        const who = e.fromAgent ? e.fromAgent.name : e.role;
        const text = e.kind === 'message' ? e.content : e.kind === 'send-message' ? (e.message.type === 'text' ? e.message.content : '[' + e.message.type + ']') : e.kind;
        addMessage(agent.id, who, text);
      }
      document.querySelectorAll('.agent').forEach((el) => el.classList.remove('active'));
      div.classList.add('active');
    };
    box.append(div);
  }
}

document.getElementById('send').onclick = async () => {
  const text = input.value.trim();
  if (!text || !state.active) return;
  input.value = '';
  addMessage(state.active, 'user', text);
  await api('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: state.active, prompt: text }) });
};

document.getElementById('broadcast').onclick = async () => {
  const text = prompt('Broadcast to all agents:');
  if (!text) return;
  await api('/api/broadcast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
};

document.getElementById('group').onclick = async () => {
  const room = prompt('Group room id:'); if (!room) return;
  const members = prompt('Member ids (comma separated):'); if (!members) return;
  await api('/api/group', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room, memberIds: members.split(',').map((s) => s.trim()) }) });
};

const es = new EventSource('/events');
es.onmessage = (event) => {
  const data = JSON.parse(event.data);
  addMessage(data.agentId, data.kind === 'group' ? data.who ?? 'group' : data.who ?? 'agent', data.text);
};
es.onopen = () => { status.textContent = 'live'; };
es.onerror = () => { status.textContent = 'reconnecting…'; };

loadAgents().catch((error) => { status.textContent = String(error); });
</script>
</body>
</html>`;
