// Runs inside the game page. Uses the game's own globals (s, nodes, careers, tick, ...).
// Returns milestone times (seconds) and a sampled timeline.
function runBot({ hours, every, label }) {
  // ---- silence rendering, keep game logic ----
  const logLines = [];
  renderHUD = () => {}; hudTick = () => {}; fx = () => {}; renderBattle = () => {}; renderScreens = () => {}; renderSheet = () => {};
  log = t => { logLines.push(t); };
  notice = () => {};
  showDiscovery = () => { discoveryQueue.length = 0; };
  renderAll = () => { checkDiscoveries(); recordJournal(); dirty = false; };
  // caches for hot functions
  let ver = 0;
  const _stats = stats, _income = income, _perk = perkValue, _mp = masteryPerks;
  let cS = null, cI = null, cP = {}, kS = -1, kI = -1, kP = -1, cM = null, kM = -1;
  stats = () => { if (kS !== ver) { cS = _stats(); kS = ver; } return cS; };
  masteryPerks = () => { if (kM !== ver) { cM = _mp(); kM = ver; } return cM; };
  income = () => { if (kI !== ver) { cI = _income(); kI = ver; } return cI; };
  perkValue = k => { if (kP !== ver) { cP = {}; kP = ver; } if (!(k in cP)) cP[k] = _perk(k); return cP[k]; };
  const _win = win; win = () => { ver++; _win(); ver++; };

  const byId = {}; nodes.forEach(n => byId[n.id] = n);
  const ownedSet = () => new Set(s.owned);
  const mastered = i => !!s.progress[i]?.mastered;
  const masteredCount = () => Object.keys(s.progress).filter(i => +i > 0 && s.progress[i].mastered).length;

  // ---------- skill choice ----------
  function dijkstra(own) {
    const dist = {}, prev = {}, done = new Set();
    const adj = {};
    for (const v of nodes) { if (v.all) continue; if (v.master && !mastered(v.master)) continue; for (const r of v.req) (adj[r] ||= []).push(v); }
    const pq = [];
    for (const id of own) { dist[id] = 0; pq.push([0, id]); }
    while (pq.length) {
      let bi = 0; for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
      const [d, u] = pq.splice(bi, 1)[0];
      if (done.has(u)) continue; done.add(u);
      for (const v of adj[u] || []) { if (own.has(v.id)) continue; const nd = d + v.cost; if (dist[v.id] === undefined || nd < dist[v.id]) { dist[v.id] = nd; prev[v.id] = u; pq.push([nd, v.id]); } }
    }
    return { dist, prev };
  }
  function firstStep(target, prev, own) { let cur = target; while (prev[cur] !== undefined && !own.has(prev[cur])) cur = prev[cur]; return cur; }
  function expandGoal(id, own) { const n = byId[id]; if (own.has(id)) return []; if (n.all) { if (n.req.every(r => own.has(r))) return [id]; return n.req.filter(r => !own.has(r)).flatMap(r => expandGoal(r, own)); } return [id]; }
  function chooseSkill() {
    const own = ownedSet();
    const { dist, prev } = dijkstra(own);
    const reach = id => { const n = byId[id]; if (n.all) return n.req.every(r => own.has(r)) ? n.cost : Infinity; return dist[id] ?? Infinity; };
    let goals = [];
    // nearest career not yet qualified
    let best = null, bestCost = Infinity;
    careers.forEach((c, i) => { if (!i || qualifies(c)) return; const g = c[3].flatMap(nm => expandGoal(byName[nm], own)); const cost = g.reduce((a, id) => a + reach(id), 0); if (cost < bestCost) { bestCost = cost; best = g; } });
    if (best && bestCost < Infinity) goals.push(...best);
    // abilities while slots are not filled
    const abil = Object.keys(abilities).filter(n => owned(byName[n]));
    if (abil.length < slots() + 1) nodes.filter(n => n.ability && !own.has(n.id)).forEach(n => goals.push(...expandGoal(n.id, own)));
    // perk nodes later on
    if (!goals.length) nodes.filter(n => n.perk && !own.has(n.id)).forEach(n => goals.push(n.id));
    if (!goals.length) { // anything: prefer cheapest, then power
      const av = nodes.filter(available).filter(n => !(n.master && !mastered(n.master)));
      av.sort((a, b) => a.cost - b.cost || (b.stat === 'power') - (a.stat === 'power'));
      return av[0];
    }
    let tgt = null, td = Infinity; for (const g of new Set(goals)) { const d = reach(g); if (d < td) { td = d; tgt = g; } }
    if (!tgt) return null;
    const n = byId[tgt];
    if (n.all) return available(n) ? n : null;
    return byId[firstStep(tgt, prev, own)];
  }
  function spendLP() {
    let guard = 50;
    while (guard--) {
      const n = chooseSkill(); if (!n || !available(n) || s.lp < n.cost) break;
      s.lp -= n.cost; s.owned.push(n.id); ver++;
    }
    renderAll();
  }
  // ---------- abilities ----------
  function equipBest() {
    const list = Object.keys(abilities).filter(n => owned(byName[n]));
    list.sort((a, b) => score(abilities[b]) - score(abilities[a]));
    s.equipped = list.slice(0, slots());
    function score(a) { const st = stats(); return abilityDamage(a, st) / a.cd + 0.6 * abilityHeal(a, st) / a.cd; }
  }
  // ---------- combat estimate ----------
  const enemiesFor = t => trackEnemies(t);
  const estimate = (e, j) => battleForecast(e, j);
  const gated = (t, j, len) => isGated(t, j);
  
  function chooseTrack() {
    const tracksOk = careers.map((c, i) => i).filter(i => i === 0 || qualifies(careers[i]));
    let push = null;
    for (const t of tracksOk) {
      const p = s.progress[t] || { unlocked: 0, mastered: false }; if (p.mastered) continue;
      const E = enemiesFor(t), j = p.unlocked; if (gated(t, j, E.length)) continue;
      const est = estimate(E[j], j); if (est.ok && (!push || est.ttk < push.ttk)) push = { t, ttk: est.ttk };
    }
    if (push) { switchTrack(push.t); s.auto = true; if (s.stage < s.unlocked && !s.retry) { s.stage = s.unlocked; resetBattle(); } return 'push'; }
    // farm: best xp/s among feasible cleared stages
    let farm = null;
    for (const t of tracksOk) { const p = s.progress[t] || { unlocked: 0 }; const E = enemiesFor(t); for (let j = 0; j <= Math.min(p.unlocked, E.length - 1); j++) { if (gated(t, j, E.length)) continue; const est = estimate(E[j], j); if (est.ok && (!farm || est.xps > farm.xps)) farm = { t, j, xps: est.xps }; } }
    if (farm) { switchTrack(farm.t); s.auto = false; if (s.stage !== farm.j) { s.stage = farm.j; resetBattle(); } return 'farm'; }
    switchTrack(0); s.auto = true; return 'none';
  }
  function bestCareer() {
    let bi = s.career, bv = -1;
    careers.forEach((c, i) => { if (!qualifies(c)) return; const v = c[2] * (1 + careerRank(i) * .15) + c[4] * 0.5; if (v > bv) { bv = v; bi = i; } });
    if (bi !== s.career) { s.career = bi; ver++; }
  }
  // ---------- shopping ----------
  const V = (p, h, d) => p + h * 0.07 + d * 1.6;
  function shop() {
    let guard = 40;
    while (guard--) {
      const opts = [];
      // gear
      for (const slot of gearSlots) {
        const cur = s.gear.find(i => items[i][5] === slot); const cv = cur === undefined ? 0 : V(items[cur][2], items[cur][3], items[cur][4]);
        items.forEach((it, i) => { if (it[5] !== slot) return; const gain = V(it[2], it[3], it[4]) - cv; if (gain <= 0) return; if (s.inventory[i]) opts.push({ gain, cost: 0.01, f: () => equip(i) }); else if (s.parts >= Math.ceil(it[1] / 25)) opts.push({ gain, cost: 0.02, f: () => { s.parts -= Math.ceil(it[1] / 25); s.inventory[i] = 1; equip(i); } }); else opts.push({ gain, cost: it[1], f: () => { s.money -= it[1]; s.inventory[i] = 1; equip(i); } }); });
      }
      // gear upgrades
      for (const i of s.gear) { const lv = s.gearLv[i] || 0; if (lv >= 10) continue; const it = items[i], c = gearUpgradeCost(i); opts.push({ gain: V(it[2], it[3], it[4]) * .15, cost: c, f: () => { s.money -= c; s.gearLv[i] = lv + 1; } }); }
      // training
      { const st = stats(); for (const [k] of TRAINING) { const c = trainingCost(k); opts.push({ gain: k === 'p' ? V(st.p * .03, 0, 0) : k === 'h' ? V(0, st.h * .03, 0) : V(0, 0, st.d * .04), cost: c, f: () => { s.money -= c; s.training[k]++; } }); } }
      // home
      const prices = [120, 450, 1500]; if (s.home < 3) opts.push({ gain: V(2, 25, 1) + 3, cost: prices[s.home], f: () => { s.money -= prices[s.home]; s.home++; } });
      rooms.forEach((r, j) => { if (s.rooms.includes(j) || s.home < r[1] || !owned(r[3])) return; opts.push({ gain: 2, cost: r[2], f: () => { s.money -= r[2]; s.rooms.push(j); } }); });
      furniture.forEach((f, k) => { if (!s.rooms.includes(f[1])) return; const cur = s.decor[f[1]]; const fv = x => V(x[4], x[5], x[6]) + x[7] * 30 + x[8] * 40; const gain = fv(f) - (cur === undefined ? 0 : fv(furniture[cur])); if (gain <= 0) return; if (s.furniture[k]) opts.push({ gain, cost: .01, f: () => { s.decor[f[1]] = k; } }); else opts.push({ gain, cost: f[2], f: () => { s.money -= f[2]; s.furniture[k] = 1; s.decor[f[1]] = k; } }); });
      // pets: active pet only matters
      pets.forEach((p, i) => { const l = s.pets[i] || 0; if (l >= 5 || !owned(p[2])) return; const c = p[1] * (l + 1); const per = V(p[3], p[4], p[5]) + p[6] * .3; const act = s.activePet === null ? 0 : V(...['p', 'h', 'd'].map(k => petBonus()[k])); const gain = per * (l + 1) - act; if (gain <= 0) return; opts.push({ gain, cost: c, f: () => { s.money -= c; s.pets[i] = l + 1; s.activePet = i; } }); });
      // business: value income as gain
      careers.forEach((c, i) => { if (!i || !mastered(i)) return; const l = s.businesses[i] || 0; if (l >= 5) return; const cost = businessCost(i); opts.push({ gain: c[2] * .35 * 0.4, cost, f: () => { s.money -= cost; s.businesses[i] = l + 1; } }); });
      const aff = opts.filter(o => o.cost <= s.money + 1e-9);
      if (!aff.length) break;
      aff.sort((a, b) => b.gain / b.cost - a.gain / a.cost);
      // don't blow cash on tiny gains if a much better option is close to affordable
      const allBest = opts.sort((a, b) => b.gain / b.cost - a.gain / a.cost)[0];
      const pick = aff[0];
      if (guard < 0) break;
      if (allBest !== pick && allBest.cost < s.money * 2 && allBest.gain / allBest.cost > 2 * pick.gain / pick.cost && pick.cost > 1) break;
      pick.f(); ver++;
    }
    function equip(i) { s.gear = s.gear.filter(j => items[j][5] !== items[i][5]); s.gear.push(i); }
  }

  // ---------- run ----------
  const M = {}; const mark = (k, t) => { if (M[k] === undefined) M[k] = t; };
  const timeline = []; let deaths = 0; const _rb = resetBattle;
  let lastUnlockT = 0, lastUnlockSig = '', longestWall = 0, wallStart = 0, wallAt = null;
  const T = hours * 3600;
  const decide = () => { if (globalThis.__noDecide) return; spendLP(); bestCareer(); equipBest(); shop(); ver++; chooseTrack(); renderAll(); };
  decide();
  for (let t = 1; t <= T; t++) {
    const hpBefore = s.stage;
    tick();
    if (logLines.length && logLines[logLines.length - 1].startsWith('Overwhelmed')) { deaths++; logLines.length = 0; } else if (logLines.length > 50) logLines.length = 0;
    if (t % every === 0) decide();
    // milestones
    const sk = s.owned.length - 1, disc = s.discovered.filter(i => i > 0).length, mc = masteredCount();
    for (const L of [5, 10, 12, 15, 20, 25, 30, 40, 50, 60]) if (s.level >= L) mark('level ' + L, t);
    for (const k of [12, 25, 50, 100, 200, 300, 404]) if (sk >= k) mark(k + ' skills', t);
    for (const k of [1, 5, 10, 19, 27]) if (disc >= k) mark(k + ' careers discovered', t);
    for (const k of [1, 5, 10, 19, 27]) if (mc >= k) mark(k + ' careers mastered', t);
    if (s.progress[0]?.mastered) mark('Everyday Life mastered', t);
    for (const T of [1, 2, 3, 4]) { const tr = careers.map((c, i) => i).filter(i => i && careerTier(i) === T); if (tr.some(i => s.progress[i]?.mastered)) mark('first tier ' + T + ' mastery', t); if (tr.every(i => s.progress[i]?.mastered)) mark('all tier ' + T + ' mastered', t); }
    if (s.equipped.length) mark('first ability equipped', t);
    if (s.home >= 3) mark('Dream home', t);
    if (Object.keys(s.businesses).length) mark('first business', t);
    if (Object.keys(s.pets).length) mark('first companion', t);
    if (s.achievements.length >= achievements.length) mark('all achievements', t);
    if (s.discovered.some(i => i >= 20)) mark('first gateway career', t);
    // walls: time with no new stage unlocked anywhere
    const sig = Object.values(s.progress).map(p => p.unlocked + (p.mastered ? 'm' : '')).join(',');
    if (sig !== lastUnlockSig) { const gap = t - lastUnlockT; if (gap > longestWall) { longestWall = gap; wallAt = { from: lastUnlockT, level: s.level }; } lastUnlockSig = sig; lastUnlockT = t; }
    if (t % 900 === 0) { const st = stats(); timeline.push({ t, level: s.level, sk, disc, mc, money: Math.round(s.money), inc: +income().toFixed(1), p: st.p, h: st.h, d: st.d, lp: s.lp, track: s.track, wins: s.wins, deaths }); }
  }
  return { label, M, timeline, deaths, longestWall, wallAt, final: { level: s.level, skills: s.owned.length - 1, disc: s.discovered.filter(i => i > 0).length, mastered: masteredCount(), money: Math.round(s.money), achievements: s.achievements.length, home: s.home, businesses: Object.keys(s.businesses).length } };
}
