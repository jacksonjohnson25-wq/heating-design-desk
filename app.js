/* ===================== STATE ===================== */
let state = {
  project: { flowTemp: 45, returnTemp: 40, dhwFlowTemp: 65 },
  rooms: [],
  pipeLib: [],
  radLib: [],
  branches: [],
  dhw: { vdraw: 286, targetTemp: 60, targetReheatMinutes: 240 },
};
let nextId = 1;
const uid = () => nextId++;

/* ===================== CIBSE CONSTANTS ===================== */
const SHC = 4180; // J/kg.K, CIBSE p.5-31
const CYL_TEMP_FACTOR = { 50: 0.417, 55: 0.573, 60: 0.729 }; // Table 4-4
const FHX_TABLE = { // Table 4-5, CIBSE p.4-26/27  [flowTemp][targetTemp] = fhx
  55: { 50: 0.00146 },
  65: { 50: 0.00074, 55: 0.00109, 60: 0.00167 },
  75: { 50: 0.00051, 55: 0.00070, 60: 0.00092 },
};
const F2_OPTIONS = [ ["TBSE (top+bottom same end)", 1.00], ["TBOE (top+bottom opposite ends)", 1.05], ["BOE (bottom opposite ends) — most common", 0.96] ];
const F3_OPTIONS = [ ["Fixed on plain surface", 1.00], ["Shelf over radiator", 0.95], ["Fixed in open recess", 0.90], ["Cabinet, well ventilated", 0.80], ["Cabinet, poorly ventilated", 0.70] ];
const F4_OPTIONS = [ ["Oil- or water-based paint", 1.00], ["Metallic-based paint", 0.85] ];

/* ===================== CALCULATIONS ===================== */
function mwt() { return (state.project.flowTemp + state.project.returnTemp) / 2; }
function mwAt(roomTemp) { return mwt() - roomTemp; }
function f1For(roomTemp, n) { const v = mwAt(roomTemp) / 50; return Math.pow(Math.max(v,0.0001), n); }
function flowRateLs(heatLossW, deltaT) { return (heatLossW / 1000) / (SHC/1000 * deltaT); }

function pipeArea(idmm) { const r = idmm/2000; return Math.PI * r * r; } // m^2
function velocityForPipe(flowLs, idmm) { const area = pipeArea(idmm); return (flowLs/1000) / area; }

function pickPipeForFlow(flowLs) {
  const sorted = [...state.pipeLib].sort((a,b)=>a.idmm-b.idmm);
  for (const p of sorted) {
    const v = velocityForPipe(flowLs, p.idmm);
    if (v <= 1.5) return { pipe: p, velocity: v };
  }
  if (sorted.length) { const p = sorted[sorted.length-1]; return { pipe: p, velocity: velocityForPipe(flowLs, p.idmm) }; }
  return null;
}

function radiatorRequiredOutput(room) {
  const f1 = f1For(room.roomTemp, room.n || 1.3);
  const combined = f1 * room.f2 * room.f3 * room.f4;
  return { f1, combined, required: room.heatLoss / combined };
}

function suggestRadiator(requiredW) {
  const candidates = state.radLib.filter(r => r.outputAt50 >= requiredW).sort((a,b)=>a.outputAt50-b.outputAt50);
  return candidates[0] || null;
}

function branchCalc(branch) {
  const room = state.rooms.find(r => r.id === branch.roomId);
  if (!room) return null;
  const deltaT = state.project.flowTemp - state.project.returnTemp;
  const flow = flowRateLs(room.heatLoss, deltaT);
  const picked = pickPipeForFlow(flow);
  const resistanceLength = (Number(branch.length)||0) + (Number(branch.fittingsAllowance)||0);
  const pressureDrop = resistanceLength * (Number(branch.pressureLossRate)||0);
  return { room, flow, picked, resistanceLength, pressureDrop };
}

function dhwCylinderVolume() {
  const f = CYL_TEMP_FACTOR[state.dhw.targetTemp];
  return state.dhw.vdraw / f;
}
function dhwFhx() {
  const table = FHX_TABLE[state.project.dhwFlowTemp] || {};
  return table[state.dhw.targetTemp];
}
function dhwRequiredRating() {
  const fhx = dhwFhx();
  if (!fhx) return null;
  const vcyl = dhwCylinderVolume();
  return (state.dhw.targetTemp * state.project.dhwFlowTemp * vcyl * fhx) / state.dhw.targetReheatMinutes;
}
function dhwReheatTime(ratingKw) {
  const fhx = dhwFhx();
  if (!fhx || !ratingKw) return null;
  const vcyl = dhwCylinderVolume();
  return (state.dhw.targetTemp * state.project.dhwFlowTemp * vcyl * fhx) / ratingKw;
}

/* ===================== EXPORT / IMPORT ===================== */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'heating-design-project.json';
  a.click();
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      state = Object.assign({project:{},rooms:[],pipeLib:[],radLib:[],branches:[],dhw:{}}, parsed);
      nextId = 1 + Math.max(0, ...[...state.rooms,...state.pipeLib,...state.radLib,...state.branches].map(x=>x.id||0));
      renderAll();
    } catch(err) { alert('Could not read that file — is it a project JSON exported from this tool?'); }
  };
  reader.readAsText(file);
}

/* ===================== NAV ===================== */
const TABS = [
  { id: 'rooms', label: 'Rooms & heat loss' },
  { id: 'radiators', label: 'Radiator sizing' },
  { id: 'hotwater', label: 'Hot water cylinder' },
  { id: 'pipework', label: 'Pipework sizing' },
  { id: 'library', label: 'Reference library' },
];
let activeTab = 'rooms';

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = TABS.map((t,i) => `
    <div class="nav-item ${activeTab===t.id?'active':''}" onclick="setTab('${t.id}')">
      <span class="nav-num">0${i+1}</span><span>${t.label}</span>
    </div>`).join('');
}
function setTab(id) { activeTab = id; renderAll(); }

/* ===================== RENDER: ROOMS ===================== */
function renderRooms() {
  const rows = state.rooms.map(r => `
    <tr>
      <td class="name-cell"><input value="${r.name}" oninput="updateRoom(${r.id},'name',this.value)" style="border:none;background:transparent;padding:2px;font-family:var(--font-ui)"></td>
      <td><input type="number" value="${r.heatLoss}" oninput="updateRoom(${r.id},'heatLoss',+this.value)" style="border:none;background:transparent;padding:2px" class="numcell"></td>
      <td><input type="number" value="${r.floorArea}" oninput="updateRoom(${r.id},'floorArea',+this.value)" style="border:none;background:transparent;padding:2px" class="numcell"></td>
      <td class="numcell">${r.floorArea ? (r.heatLoss/r.floorArea).toFixed(1) : '—'} W/m²</td>
      <td><input type="number" value="${r.roomTemp}" oninput="updateRoom(${r.id},'roomTemp',+this.value)" style="border:none;background:transparent;padding:2px" class="numcell"></td>
      <td><button class="btn-danger-ghost" onclick="removeRoom(${r.id})">Remove</button></td>
    </tr>`).join('');
  const total = state.rooms.reduce((s,r)=>s+(Number(r.heatLoss)||0),0);

  document.getElementById('main').innerHTML = `
    <div class="panel active">
      <div class="panel-head">
        <div class="panel-eyebrow">Step 01</div>
        <div class="panel-title">Rooms &amp; heat loss</div>
        <div class="panel-sub">Enter each room's heat loss result from your survey (Elmhurst, Heat Engineer, or manual CIBSE Section 2 calculation). Everything downstream — radiator sizing, pipe sizing — is driven by this table.</div>
      </div>

      <div class="card">
        <div class="card-title">Project water temperatures <small>CIBSE p.5-25</small></div>
        <div class="grid g4">
          <div><label>Flow temperature (°C)</label><input type="number" value="${state.project.flowTemp}" oninput="updateProject('flowTemp',+this.value)"></div>
          <div><label>Return temperature (°C)</label><input type="number" value="${state.project.returnTemp}" oninput="updateProject('returnTemp',+this.value)"></div>
          <div><label>Mean Water Temp (calculated)</label><input value="${mwt().toFixed(1)} °C" disabled></div>
          <div><label>Design ΔT (calculated)</label><input value="${(state.project.flowTemp-state.project.returnTemp).toFixed(1)} K" disabled></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Import rooms <small>from a CSV export or a pasted spreadsheet range</small></div>
        <div class="note">Paste directly from Elmhurst, Heat Engineer, or an Excel/CSV export. Expected columns, in any order, with a header row: <b>Room</b>, <b>Heat Loss (W)</b>, <b>Floor Area (m²)</b>, <b>Room Temp (°C)</b> — the importer matches column names flexibly, so "Heat Loss", "Watts" or "W" all work.</div>
        <textarea id="importArea" rows="5" placeholder="Room,Heat Loss (W),Floor Area (m2),Room Temp (C)&#10;Lounge,1450,22,21&#10;Kitchen,942,18,18" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:6px;font-family:var(--font-mono);font-size:12.5px;margin-top:10px;resize:vertical"></textarea>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="importRoomsFromText()">↑ Import pasted rows</button>
          <button class="btn btn-ghost" onclick="document.getElementById('csvFileInput').click()">↑ Upload CSV file</button>
          <button class="btn btn-ghost" onclick="downloadRoomTemplate()">↓ Download CSV template</button>
        </div>
        <div id="importFeedback"></div>
        <input type="file" id="csvFileInput" accept=".csv,text/csv" style="display:none">
      </div>

      <div class="card">
        <div class="toolbar">
          <div class="card-title" style="margin:0">Room list</div>
          <button class="btn btn-primary" onclick="addRoom()">+ Add room manually</button>
        </div>
        ${state.rooms.length ? `
        <table>
          <thead><tr><th>Room</th><th class="numcell">Heat loss (W)</th><th class="numcell">Floor area (m²)</th><th class="numcell">Specific loss</th><th class="numcell">Room temp (°C)</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : `<div class="empty"><div class="empty-title">No rooms yet</div>Add your first room to begin.</div>`}
        ${state.rooms.length ? `<div class="result-strip" style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
          <div class="result-item"><div class="result-label">Total building heat loss</div><div class="result-value copper">${total.toLocaleString()}<span class="result-unit">W</span></div></div>
          <div class="result-item"><div class="result-label">Rooms</div><div class="result-value">${state.rooms.length}</div></div>
        </div>` : ''}
      </div>
    </div>`;
}
function addRoom() { state.rooms.push({id:uid(), name:'New room', heatLoss:800, floorArea:12, roomTemp:21, f2:0.96, f3:1.00, f4:1.00, n:1.3}); renderRooms(); }
function updateRoom(id, field, val) { const r = state.rooms.find(r=>r.id===id); if(r){ r[field]=val; if(field!=='name') renderRooms(); } }
function removeRoom(id) { state.rooms = state.rooms.filter(r=>r.id!==id); state.branches = state.branches.filter(b=>b.roomId!==id); renderRooms(); }
function updateProject(field, val) { state.project[field] = val; renderAll(); }

/* ===================== ROOM IMPORT ===================== */
function detectDelimiter(line) {
  const tabs = (line.match(/\t/g)||[]).length;
  const commas = (line.match(/,/g)||[]).length;
  return tabs > commas ? '\t' : ',';
}
function normaliseHeader(h) {
  return h.toLowerCase().replace(/[^a-z0-9]/g,'');
}
function matchColumn(headers, candidates) {
  for (let i=0;i<headers.length;i++) {
    const norm = normaliseHeader(headers[i]);
    if (candidates.some(c => norm.includes(c))) return i;
  }
  return -1;
}
function parseRoomCsv(text) {
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length);
  if (!lines.length) return { rooms: [], error: 'No rows found.' };
  const delim = detectDelimiter(lines[0]);
  const rows = lines.map(l => l.split(delim).map(c=>c.trim().replace(/^"|"$/g,'')));

  const headerRow = rows[0];
  // Header detection: check whether the columns AFTER the first (expected to be numeric
  // data like heat loss, area, temp) parse as numbers. If none do, it's a header row.
  // Checking column 0 alone is unreliable, since a room name always contains letters.
  const trailingCols = headerRow.slice(1);
  const anyTrailingNumeric = trailingCols.some(c => c !== '' && !isNaN(parseFloat(c)) && isFinite(c));
  const looksLikeHeader = !anyTrailingNumeric;
  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  let nameIdx=0, heatIdx=1, areaIdx=2, tempIdx=3;
  if (looksLikeHeader) {
    nameIdx = matchColumn(headerRow, ['room','name']);
    heatIdx = matchColumn(headerRow, ['heatloss','watt','w','load']);
    areaIdx = matchColumn(headerRow, ['floorarea','area','m2']);
    tempIdx = matchColumn(headerRow, ['roomtemp','temp','internaldesign']);
    if (nameIdx===-1) nameIdx=0;
    if (heatIdx===-1) heatIdx=1;
    if (areaIdx===-1) areaIdx=2;
    if (tempIdx===-1) tempIdx=3;
  }

  const rooms = [];
  const skipped = [];
  dataRows.forEach((cols, i) => {
    const name = cols[nameIdx] || `Room ${i+1}`;
    const heat = parseFloat(cols[heatIdx]);
    if (isNaN(heat)) { skipped.push(name || `row ${i+1}`); return; }
    const area = parseFloat(cols[areaIdx]) || 0;
    const temp = parseFloat(cols[tempIdx]) || 21;
    rooms.push({ id: uid(), name, heatLoss: heat, floorArea: area, roomTemp: temp, f2:0.96, f3:1.00, f4:1.00, n:1.3 });
  });
  return { rooms, skipped };
}
function importRoomsFromText() {
  const text = document.getElementById('importArea').value;
  if (!text.trim()) { showImportFeedback('Paste some rows first, or upload a CSV file.', true); return; }
  const { rooms, skipped } = parseRoomCsv(text);
  state.rooms.push(...rooms);
  renderRooms();
  const msg = `Imported ${rooms.length} room${rooms.length===1?'':'s'}.` + (skipped && skipped.length ? ` Skipped ${skipped.length} row(s) with no readable heat loss value: ${skipped.join(', ')}.` : '');
  showImportFeedback(msg, skipped && skipped.length > 0 && rooms.length === 0);
}
function handleCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('importArea').value = e.target.result;
    importRoomsFromText();
  };
  reader.readAsText(file);
}
function showImportFeedback(msg, isWarning) {
  const el = document.getElementById('importFeedback');
  if (el) el.innerHTML = `<div class="note ${isWarning?'warn':''}" style="margin-top:10px">${msg}</div>`;
}
function downloadRoomTemplate() {
  const csv = "Room,Heat Loss (W),Floor Area (m2),Room Temp (C)\nLounge,1450,22,21\nKitchen,942,18,18\nBedroom 1,780,14.5,18\n";
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'room-heat-loss-template.csv';
  a.click();
}

/* ===================== RENDER: RADIATORS ===================== */
function renderRadiators() {
  if (!state.rooms.length) {
    document.getElementById('main').innerHTML = `<div class="panel active">${panelHead('Step 02','Radiator sizing','Add rooms first — radiator sizing needs each room\u2019s heat loss.')}<div class="card"><div class="empty"><div class="empty-title">No rooms yet</div>Go to "Rooms &amp; heat loss" and add at least one room.</div></div></div>`;
    return;
  }
  const rows = state.rooms.map(r => {
    const calc = radiatorRequiredOutput(r);
    const suggestion = suggestRadiator(calc.required);
    return `<tr>
      <td class="name-cell">${r.name}</td>
      <td class="numcell">${r.heatLoss} W</td>
      <td>
        <select onchange="updateRoom(${r.id},'f2',+this.value)">${F2_OPTIONS.map(([l,v])=>`<option value="${v}" ${r.f2==v?'selected':''}>${l}</option>`).join('')}</select>
      </td>
      <td>
        <select onchange="updateRoom(${r.id},'f3',+this.value)">${F3_OPTIONS.map(([l,v])=>`<option value="${v}" ${r.f3==v?'selected':''}>${l}</option>`).join('')}</select>
      </td>
      <td>
        <select onchange="updateRoom(${r.id},'f4',+this.value)">${F4_OPTIONS.map(([l,v])=>`<option value="${v}" ${r.f4==v?'selected':''}>${l}</option>`).join('')}</select>
      </td>
      <td class="numcell">${calc.f1.toFixed(3)}</td>
      <td class="numcell" style="font-weight:600">${Math.round(calc.required).toLocaleString()} W</td>
      <td>${suggestion ? `<span class="badge badge-ok">${suggestion.name}</span>` : `<span class="badge badge-neutral">No match in library</span>`}</td>
    </tr>`;
  }).join('');

  document.getElementById('main').innerHTML = `
    <div class="panel active">
      ${panelHead('Step 02','Radiator sizing','CIBSE Equations 5.3 &amp; 5.4 (p.5-55, p.5-58) applied per room — the required catalogue rating a radiator must have once corrected for real water-to-air temperature difference, connections, enclosure and finish.')}
      <div class="card">
        <div class="card-title">Per-room correction <small>f1 × f2 × f3 × f4</small></div>
        <table>
          <thead><tr><th>Room</th><th class="numcell">Heat loss</th><th>f2 connections</th><th>f3 enclosure</th><th>f4 finish</th><th class="numcell">f1 (auto)</th><th class="numcell">Catalogue output required</th><th>Suggested radiator</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="note">f1 uses room temperature from Step 01, and the project MWT from Step 01, via f1 = (MW-AT / 50)^1.3 — CIBSE Equation 5.3, p.5-55.</div>
        ${!state.radLib.length ? `<div class="note warn">Your radiator library is empty, so no suggestions can be made yet. Add real models with their Δ50 rated output in the Reference Library tab.</div>` : ''}
      </div>
    </div>`;
}

/* ===================== RENDER: HOT WATER ===================== */
function renderHotWater() {
  const vcyl = dhwCylinderVolume();
  const fhx = dhwFhx();
  const ratingForTarget = dhwRequiredRating();
  document.getElementById('main').innerHTML = `
    <div class="panel active">
      ${panelHead('Step 03','Hot water cylinder sizing','CIBSE Equations 4.1, 4.3 &amp; 4.4 (p.4-24 to p.4-26). Enter your design hour/day draw volume — built up from actual household usage patterns, see Table 4-3 — not calculated automatically here.')}

      <div class="card">
        <div class="card-title">Demand &amp; target</div>
        <div class="grid g3">
          <div><label>Design hour/day volume, Vdraw (litres)</label><input type="number" value="${state.dhw.vdraw}" oninput="updateDhw('vdraw',+this.value)"></div>
          <div><label>Target cylinder temperature</label>
            <select onchange="updateDhw('targetTemp',+this.value)">
              ${[50,55,60].map(t=>`<option value="${t}" ${state.dhw.targetTemp==t?'selected':''}>${t} °C</option>`).join('')}
            </select>
          </div>
          <div><label>Heat generator flow temp during reheat</label>
            <select onchange="updateProject('dhwFlowTemp',+this.value)">
              ${[55,65,75].map(t=>`<option value="${t}" ${state.project.dhwFlowTemp==t?'selected':''}>${t} °C</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="result-strip" style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
          <div class="result-item"><div class="result-label">Min. cylinder volume (Eq 4.1)</div><div class="result-value copper">${Math.round(vcyl)}<span class="result-unit">litres</span></div></div>
        </div>
        ${!fhx ? `<div class="note warn">No CIBSE Table 4-5 factor exists for ${state.project.dhwFlowTemp}°C flow at ${state.dhw.targetTemp}°C target — try 65°C or 75°C flow.</div>` : ''}
      </div>

      ${fhx ? `
      <div class="card">
        <div class="card-title">Reheat time ↔ heat exchanger rating <small>Eq 4.3 / 4.4</small></div>
        <div class="grid g2">
          <div><label>Target reheat time (minutes)</label><input type="number" value="${state.dhw.targetReheatMinutes}" oninput="updateDhw('targetReheatMinutes',+this.value)"></div>
          <div><label>Required heat exchanger rating (calculated)</label><input value="${ratingForTarget.toFixed(2)} kW" disabled></div>
        </div>
        <div class="note">${state.dhw.targetReheatMinutes < 120 ? 'Reheat times under 120 minutes: CIBSE recommends checking fabric/insulation improvements, rescheduling the reheat window, or splitting reheat periods before oversizing the heat generator — see the note in your study guide.' : 'Round the rating up to the nearest available cylinder heat exchanger option when specifying.'}</div>
      </div>` : ''}
    </div>`;
}
function updateDhw(field, val) { state.dhw[field] = val; renderAll(); }

/* ===================== RENDER: PIPEWORK ===================== */
function renderPipework() {
  if (!state.rooms.length) {
    document.getElementById('main').innerHTML = `<div class="panel active">${panelHead('Step 04','Pipework sizing','Add rooms first.')}<div class="card"><div class="empty"><div class="empty-title">No rooms yet</div></div></div></div>`;
    return;
  }
  const branchRows = state.branches.map(b => {
    const c = branchCalc(b);
    if (!c) return '';
    const vOk = c.picked && c.picked.velocity >= 0.3 && c.picked.velocity <= 1.5;
    return `<tr>
      <td>
        <select onchange="updateBranch(${b.id},'roomId',+this.value)">
          ${state.rooms.map(r=>`<option value="${r.id}" ${b.roomId==r.id?'selected':''}>${r.name}</option>`).join('')}
        </select>
      </td>
      <td class="numcell">${c.flow.toFixed(4)} L/s</td>
      <td>${c.picked ? `<span class="badge ${vOk?'badge-ok':'badge-danger'}">${c.picked.pipe.name} — ${c.picked.velocity.toFixed(2)} m/s</span>` : `<span class="badge badge-neutral">No pipe fits — add to library</span>`}</td>
      <td><input type="number" value="${b.length}" oninput="updateBranch(${b.id},'length',+this.value)" style="width:70px"></td>
      <td><input type="number" value="${b.fittingsAllowance}" oninput="updateBranch(${b.id},'fittingsAllowance',+this.value)" style="width:70px"></td>
      <td><input type="number" value="${b.pressureLossRate}" oninput="updateBranch(${b.id},'pressureLossRate',+this.value)" style="width:70px"></td>
      <td class="numcell" style="font-weight:600">${c.pressureDrop.toFixed(1)} Pa</td>
      <td><button class="btn-danger-ghost" onclick="removeBranch(${b.id})">Remove</button></td>
    </tr>`;
  }).join('');

  let indexNote = '';
  if (state.branches.length) {
    const calcs = state.branches.map(b=>({b, c:branchCalc(b)})).filter(x=>x.c);
    if (calcs.length) {
      const worst = calcs.reduce((a,x)=> x.c.pressureDrop > a.c.pressureDrop ? x : a);
      const totalFlow = calcs.reduce((s,x)=>s+x.c.flow,0);
      const mainPipe = pickPipeForFlow(totalFlow);
      indexNote = `
      <div class="card">
        <div class="card-title">Main flow &amp; index circuit <small>CIBSE p.5-44</small></div>
        <div class="result-strip">
          <div class="result-item"><div class="result-label">Total branch flow</div><div class="result-value">${totalFlow.toFixed(3)}<span class="result-unit">L/s</span></div></div>
          <div class="result-item"><div class="result-label">Main pipe size</div><div class="result-value copper">${mainPipe ? mainPipe.pipe.name : '—'}</div></div>
          <div class="result-item"><div class="result-label">Index circuit (highest ΔP)</div><div class="result-value copper">${worst.c.room.name}</div></div>
          <div class="result-item"><div class="result-label">Index circuit pressure drop</div><div class="result-value">${worst.c.pressureDrop.toFixed(1)}<span class="result-unit">Pa</span></div></div>
        </div>
        <div class="note">The circulator (pump) must be sized to overcome the index circuit branch — every other branch will then receive adequate flow once balanced on site.</div>
      </div>`;
    }
  }

  document.getElementById('main').innerHTML = `
    <div class="panel active">
      ${panelHead('Step 04','Pipework sizing','CIBSE Equation 5.1 (p.5-31) for flow rate, velocity-checked against your pipe library (target ~1.0 m/s, range 0.3–1.5 m/s).')}
      ${velocityGaugeCard()}
      <div class="card">
        <div class="toolbar">
          <div class="card-title" style="margin:0">Branches</div>
          <button class="btn btn-primary" onclick="addBranch()">+ Add branch</button>
        </div>
        ${state.branches.length ? `
        <table>
          <thead><tr><th>Room</th><th class="numcell">Flow rate</th><th>Pipe &amp; velocity</th><th>Length (m)</th><th>Fittings (m)</th><th>ΔP rate (Pa/m)</th><th class="numcell">Total ΔP</th><th></th></tr></thead>
          <tbody>${branchRows}</tbody>
        </table>` : `<div class="empty"><div class="empty-title">No branches yet</div>Add a branch per room to calculate its pipe size.</div>`}
        ${!state.pipeLib.length ? `<div class="note warn">Your pipe library is empty — add real sizes from your pipe manufacturer's datasheet in the Reference Library tab before these results mean anything.</div>` : ''}
      </div>
      ${indexNote}
    </div>`;
}
function addBranch() {
  if (!state.rooms.length) return;
  state.branches.push({id:uid(), roomId: state.rooms[0].id, length:8, fittingsAllowance:1.5, pressureLossRate:250});
  renderPipework();
}
function updateBranch(id, field, val) { const b = state.branches.find(b=>b.id===id); if(b){ b[field]=val; renderPipework(); } }
function removeBranch(id) { state.branches = state.branches.filter(b=>b.id!==id); renderPipework(); }

function velocityGaugeCard() {
  if (!state.branches.length || !state.pipeLib.length) return '';
  const first = state.branches[0];
  const c = branchCalc(first);
  const v = c && c.picked ? c.picked.velocity : 0;
  return `<div class="card">
    <div class="card-title">Velocity check <small>first branch — live readout</small></div>
    <div class="gauge-wrap">
      ${gaugeSvg(v)}
      <div class="gauge-readout">
        <div class="big">${v.toFixed(2)} m/s</div>
        <div class="lbl">${c && c.room ? c.room.name : ''}</div>
        <div class="lbl" style="margin-top:6px">Target ~1.0 · Range 0.3–1.5</div>
      </div>
    </div>
  </div>`;
}
function gaugeSvg(velocity) {
  const min=0, max=2.0;
  const clamped = Math.max(min, Math.min(max, velocity));
  const angle = -120 + (clamped/max)*240;
  const cx=70, cy=70, r=54;
  const toXY = (deg) => { const rad=(deg-90)*Math.PI/180; return [cx+r*Math.cos(rad), cy+r*Math.sin(rad)]; };
  const arc = (a1,a2,color,width=10) => {
    const [x1,y1]=toXY(a1), [x2,y2]=toXY(a2);
    const large = (a2-a1)>180?1:0;
    return `<path d="M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round"/>`;
  };
  const dangerLowEnd = -120 + (0.3/max)*240;
  const okEnd = -120 + (1.5/max)*240;
  const [nx,ny] = toXY(angle);
  return `<svg width="140" height="90" viewBox="0 0 140 90">
    ${arc(-120, dangerLowEnd, '#B23B33')}
    ${arc(dangerLowEnd, okEnd, '#3F7D58')}
    ${arc(okEnd, 120, '#B23B33')}
    <line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#16232E" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="4" fill="#16232E"/>
  </svg>`;
}

/* ===================== RENDER: LIBRARY ===================== */
function renderLibrary() {
  const pipeRows = state.pipeLib.map(p => `<tr>
    <td><input value="${p.name}" oninput="updatePipe(${p.id},'name',this.value)" style="border:none;background:transparent;padding:2px;font-family:var(--font-ui)"></td>
    <td><input type="number" value="${p.idmm}" oninput="updatePipe(${p.id},'idmm',+this.value)" style="border:none;background:transparent;padding:2px" class="numcell"></td>
    <td class="numcell">${(pipeArea(p.idmm)*1000*1.0).toFixed(3)} L/s @1.0m/s</td>
    <td><button class="btn-danger-ghost" onclick="removePipe(${p.id})">Remove</button></td>
  </tr>`).join('');
  const radRows = state.radLib.map(r => `<tr>
    <td><input value="${r.name}" oninput="updateRad(${r.id},'name',this.value)" style="border:none;background:transparent;padding:2px;font-family:var(--font-ui)"></td>
    <td><input type="number" value="${r.outputAt50}" oninput="updateRad(${r.id},'outputAt50',+this.value)" style="border:none;background:transparent;padding:2px" class="numcell"></td>
    <td><button class="btn-danger-ghost" onclick="removeRad(${r.id})">Remove</button></td>
  </tr>`).join('');

  document.getElementById('main').innerHTML = `
    <div class="panel active">
      ${panelHead('Step 05','Reference library','This tool ships empty on purpose — enter real figures from your chosen pipe manufacturer\u2019s technical guide and radiator supplier\u2019s catalogue (BS EN 442 \u039450 rating). Export your library once built so your whole team can import the same file.')}

      <div class="card">
        <div class="toolbar"><div class="card-title" style="margin:0">Pipe sizes</div><button class="btn btn-primary" onclick="addPipe()">+ Add pipe size</button></div>
        ${state.pipeLib.length ? `<table><thead><tr><th>Name / nominal size</th><th class="numcell">Internal diameter (mm)</th><th class="numcell">Max flow @1.0 m/s</th><th></th></tr></thead><tbody>${pipeRows}</tbody></table>` : `<div class="empty"><div class="empty-title">No pipe sizes yet</div>Add sizes exactly as listed in your manufacturer's datasheet (internal diameter, not nominal/outer size).</div>`}
      </div>

      <div class="card">
        <div class="toolbar"><div class="card-title" style="margin:0">Radiator models</div><button class="btn btn-primary" onclick="addRad()">+ Add radiator</button></div>
        ${state.radLib.length ? `<table><thead><tr><th>Model / name</th><th class="numcell">Rated output @ Δ50 (W)</th><th></th></tr></thead><tbody>${radRows}</tbody></table>` : `<div class="empty"><div class="empty-title">No radiator models yet</div>Add each model's BS EN 442 Δ50 rated output from the manufacturer's Declaration of Performance.</div>`}
      </div>

      <div class="card">
        <div class="card-title">Save &amp; share your project</div>
        <div class="note">Export includes rooms, radiator/pipe libraries, branches and hot water settings — everything in this session. No data ever leaves this page automatically.</div>
        <div class="btn-row">
          <button class="btn btn-primary" onclick="exportData()">↓ Export project (.json)</button>
          <button class="btn btn-ghost" onclick="document.getElementById('importInput').click()">↑ Import project</button>
        </div>
      </div>
    </div>`;
}
function addPipe() { state.pipeLib.push({id:uid(), name:'15mm', idmm:13.6}); renderLibrary(); }
function updatePipe(id, field, val) { const p = state.pipeLib.find(p=>p.id===id); if(p){ p[field]=val; if(field!=='name') renderLibrary(); } }
function removePipe(id) { state.pipeLib = state.pipeLib.filter(p=>p.id!==id); renderLibrary(); }
function addRad() { state.radLib.push({id:uid(), name:'New radiator', outputAt50:1000}); renderLibrary(); }
function updateRad(id, field, val) { const r = state.radLib.find(r=>r.id===id); if(r){ r[field]=val; if(field!=='name') renderLibrary(); } }
function removeRad(id) { state.radLib = state.radLib.filter(r=>r.id!==id); renderLibrary(); }

/* ===================== SHARED ===================== */
function panelHead(eyebrow, title, sub) {
  return `<div class="panel-head"><div class="panel-eyebrow">${eyebrow}</div><div class="panel-title">${title}</div><div class="panel-sub">${sub}</div></div>`;
}

/* ===================== INIT ===================== */
function renderAll() {
  renderNav();
  if (activeTab==='rooms') renderRooms();
  else if (activeTab==='radiators') renderRadiators();
  else if (activeTab==='hotwater') renderHotWater();
  else if (activeTab==='pipework') renderPipework();
  else if (activeTab==='library') renderLibrary();
}

document.getElementById('importInput').addEventListener('change', e => {
  if (e.target.files[0]) importData(e.target.files[0]);
});
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'csvFileInput' && e.target.files[0]) handleCsvFile(e.target.files[0]);
});

renderAll();
