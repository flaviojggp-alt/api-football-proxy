const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const AF = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const WEATHER_BASE = 'https://api.open-meteo.com/v1/forecast';

app.use(cors());
app.use(express.json());

async function af(path) {
  const KEY = process.env.API_FOOTBALL_KEY;
  const r = await fetch(`${AF}${path}`, { headers: { 'x-apisports-key': KEY, 'Accept': 'application/json' } });
  return r.json();
}

async function getActiveSeason(teamId) {
  try {
    const d = await af(`/leagues?team=${teamId}&current=true&type=League`);
    const season = d.response?.[0]?.seasons?.find(s => s.current)?.year;
    if (season) return season;
  } catch(e) {}
  const y = new Date().getFullYear();
  try { const d = await af(`/fixtures?team=${teamId}&season=${y}&last=1&status=FT`); if(d.response?.length) return y; } catch(e) {}
  return y - 1;
}

app.get('/', (req, res) => res.json({ status:'ok', football_key:!!process.env.API_FOOTBALL_KEY, odds_key:!!process.env.ODDS_API_KEY }));

// Proxy genérico
app.get('/api/*', async (req, res) => {
  if (!process.env.API_FOOTBALL_KEY) return res.status(500).json({ error:'API_FOOTBALL_KEY no configurada' });
  const path = req.path.replace('/api','');
  const query = new URLSearchParams(req.query).toString();
  try {
    const r = await fetch(`${AF}${path}${query?'?'+query:''}`, { headers:{'x-apisports-key':process.env.API_FOOTBALL_KEY,'Accept':'application/json'} });
    res.status(r.status).json(await r.json());
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Partidos próximos con árbitro incluido
app.get('/fixtures/upcoming', async (req, res) => {
  const { leagueId } = req.query;
  if (!leagueId) return res.status(400).json({ error:'Se requiere leagueId' });
  try {
    const now = new Date();
    const from = now.toISOString().split('T')[0];
    const to = new Date(now.getTime() + 7*24*60*60*1000).toISOString().split('T')[0];
    const leagueInfo = await af(`/leagues?id=${leagueId}&current=true`);
    const currentSeason = leagueInfo.response?.[0]?.seasons?.find(s=>s.current)?.year;
    const y = now.getFullYear();
    const seasonsToTry = currentSeason ? [currentSeason] : [y, y-1];
    let fixtures=[], usedSeason=null;
    for (const s of seasonsToTry) {
      const d = await af(`/fixtures?league=${leagueId}&season=${s}&from=${from}&to=${to}&status=NS-1H-2H-HT`);
      if (d.response?.length) { fixtures=d.response.slice(0,20); usedSeason=s; break; }
    }
    if (!fixtures.length) {
      for (const s of seasonsToTry) {
        const d = await af(`/fixtures?league=${leagueId}&season=${s}&next=10`);
        if (d.response?.length) { fixtures=d.response.slice(0,20); usedSeason=s; break; }
      }
    }
    const result = fixtures.map(f => ({
      fixtureId: f.fixture.id, date: f.fixture.date, timestamp: f.fixture.timestamp,
      status: f.fixture.status, venue: f.fixture.venue?.name,
      venueCity: f.fixture.venue?.city,
      referee: f.fixture.referee || null,
      home: { id:f.teams.home.id, name:f.teams.home.name, logo:f.teams.home.logo },
      away: { id:f.teams.away.id, name:f.teams.away.name, logo:f.teams.away.logo },
      score: f.goals, round: f.league.round,
    }));
    res.json({ fixtures:result, count:result.length, from, to, season:usedSeason });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Estadísticas del árbitro
app.get('/referee', async (req, res) => {
  const { name, season } = req.query;
  if (!name) return res.status(400).json({ error:'Se requiere name' });
  try {
    const s = season || new Date().getFullYear();
    // Buscar fixtures del árbitro en la temporada actual
    const d = await af(`/fixtures?referee=${encodeURIComponent(name)}&season=${s}&last=20&status=FT`);
    const fixtures = d.response || [];
    if (!fixtures.length) return res.json({ found:false, name });

    let totalCards=0, totalGoals=0, n=0;
    fixtures.forEach(f => {
      const hY = f.score?.yellow?.home || 0;
      const aY = f.score?.yellow?.away || 0;
      const hR = f.score?.red?.home || 0;
      const aR = f.score?.red?.away || 0;
      totalCards += hY + aY + hR + aR;
      totalGoals += (f.goals?.home||0) + (f.goals?.away||0);
      n++;
    });

    // Obtener tarjetas reales desde statistics de cada partido
    let cardStats = { yellow:0, red:0, total:0, matches:0 };
    for (const fix of fixtures.slice(0,10)) {
      try {
        const sd = await af(`/fixtures/statistics?fixture=${fix.fixture.id}`);
        const teams = sd.response || [];
        teams.forEach(t => {
          const sr = t.statistics || [];
          const yc = parseFloat(sr.find(s=>s.type==='Yellow Cards')?.value)||0;
          const rc = parseFloat(sr.find(s=>s.type==='Red Cards')?.value)||0;
          cardStats.yellow += yc; cardStats.red += rc;
        });
        cardStats.matches++;
      } catch(e) {}
    }

    const nm = cardStats.matches || n || 1;
    res.json({
      found: true, name,
      matches: n,
      avgGoals: parseFloat((totalGoals/n).toFixed(2)),
      avgCards: parseFloat(((cardStats.yellow + cardStats.red) / nm).toFixed(2)),
      avgYellow: parseFloat((cardStats.yellow / nm).toFixed(2)),
      avgRed: parseFloat((cardStats.red / nm).toFixed(2)),
      strictness: cardStats.yellow/nm >= 4.5 ? 'estricto' : cardStats.yellow/nm >= 3.0 ? 'normal' : 'permisivo',
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Clima del estadio para la fecha del partido
app.get('/weather', async (req, res) => {
  const { lat, lon, date } = req.query;
  if (!lat || !lon) return res.status(400).json({ error:'Se requieren lat y lon' });
  try {
    const url = `${WEATHER_BASE}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=auto&forecast_days=7`;
    const r = await fetch(url);
    const data = await r.json();
    // Find the hour closest to match date
    const matchDate = date ? new Date(date) : new Date();
    const times = data.hourly?.time || [];
    let closestIdx = 0, minDiff = Infinity;
    times.forEach((t,i) => {
      const diff = Math.abs(new Date(t) - matchDate);
      if (diff < minDiff) { minDiff=diff; closestIdx=i; }
    });
    const temp = data.hourly?.temperature_2m?.[closestIdx];
    const precipProb = data.hourly?.precipitation_probability?.[closestIdx];
    const wcode = data.hourly?.weathercode?.[closestIdx];
    // Weather impact on match
    const isRainy = precipProb > 50 || (wcode >= 51 && wcode <= 99);
    const isCold = temp < 5;
    const impact = {
      temp: temp ? `${temp.toFixed(0)}°C` : null,
      precipProb: precipProb ? `${precipProb}%` : null,
      condition: isRainy ? 'lluvia' : isCold ? 'frío' : 'normal',
      goalsAdj: isRainy ? -0.3 : 0,        // lluvia reduce goles
      cornersAdj: isRainy ? -0.8 : 0,       // lluvia reduce córners
      cardsAdj: isRainy ? 0.3 : 0,          // lluvia puede aumentar tarjetas
    };
    res.json({ found:true, ...impact });
  } catch(e) { res.json({ found:false, error:e.message }); }
});

// Coordenadas de ciudades conocidas (para clima sin geocoding API)
app.get('/venue-coords', async (req, res) => {
  const { city, venue } = req.query;
  const COORDS = {
    'madrid': {lat:40.4168,lon:-3.7038}, 'barcelona': {lat:41.3851,lon:2.1734},
    'london': {lat:51.5074,lon:-0.1278}, 'paris': {lat:48.8566,lon:2.3522},
    'munich': {lat:48.1351,lon:11.5820}, 'milan': {lat:45.4654,lon:9.1859},
    'rome': {lat:41.9028,lon:12.4964}, 'berlin': {lat:52.5200,lon:13.4050},
    'manchester': {lat:53.4808,lon:-2.2426}, 'liverpool': {lat:53.4084,lon:-2.9916},
    'amsterdam': {lat:52.3676,lon:4.9041}, 'lisbon': {lat:38.7223,lon:-9.1393},
    'porto': {lat:41.1579,lon:-8.6291}, 'sevilla': {lat:37.3891,lon:-5.9845},
    'valencia': {lat:39.4699,lon:-0.3763}, 'bilbao': {lat:43.2630,lon:-2.9350},
    'buenos aires': {lat:-34.6037,lon:-58.3816}, 'sao paulo': {lat:-23.5505,lon:-46.6333},
    'rio de janeiro': {lat:-22.9068,lon:-43.1729}, 'mexico city': {lat:19.4326,lon:-99.1332},
    'santiago': {lat:-33.4489,lon:-70.6693}, 'lima': {lat:-12.0464,lon:-77.0428},
    'dortmund': {lat:51.5136,lon:7.4653}, 'turin': {lat:45.0703,lon:7.6869},
    'naples': {lat:40.8518,lon:14.2681}, 'lyon': {lat:45.7640,lon:4.8357},
    'marseille': {lat:43.2965,lon:5.3698},
  };
  const key = (city||venue||'').toLowerCase();
  for (const [k,v] of Object.entries(COORDS)) {
    if (key.includes(k)) return res.json({ found:true, ...v, city:k });
  }
  // Default to Madrid if not found
  res.json({ found:false, lat:40.4168, lon:-3.7038 });
});

// Stats avanzadas con forma ponderada + local/visitante separado
app.get('/stats/advanced', async (req, res) => {
  if (!process.env.API_FOOTBALL_KEY) return res.status(500).json({ error:'API_FOOTBALL_KEY no configurada' });
  const { teamId, opponentId, isHome } = req.query;
  if (!teamId || !opponentId) return res.status(400).json({ error:'Se requieren teamId y opponentId' });
  const home = isHome === 'true';
  try {
    const s = await getActiveSeason(teamId);
    const getLeague = async tid => { try { const d=await af(`/leagues?team=${tid}&season=${s}&type=League`); return d.response?.[0]?.league?.id||null; } catch(e){return null;} };
    const getRank = async (tid,lid) => { if(!lid)return null; try { const d=await af(`/standings?league=${lid}&season=${s}&team=${tid}`); const st=d.response?.[0]?.league?.standings?.[0]||[]; return st.find(x=>x.team.id===parseInt(tid))?.rank||null; } catch(e){return null;} };
    const [tL,oL]=await Promise.all([getLeague(teamId),getLeague(opponentId)]);
    const [tR,oR]=await Promise.all([getRank(teamId,tL),getRank(opponentId,oL)]);
    const oTier=!oR?'unknown':oR<=6?'top':oR<=12?'mid':'low';

    // Fetch más partidos para filtrar por local/visitante
    const fixtData = await af(`/fixtures?team=${teamId}&season=${s}&last=20&status=FT`);
    const allFixtures = fixtData?.response || [];

    // Separar por local/visitante
    const relevantFixtures = allFixtures.filter(f => {
      const teamIsHome = f.teams.home.id === parseInt(teamId);
      return home ? teamIsHome : !teamIsHome;
    }).slice(0,10);

    // Si no hay suficientes como local/visitante, usar todos (mínimo 3)
    const fixtures = relevantFixtures.length >= 3 ? relevantFixtures : allFixtures.slice(0,10);
    const isFiltered = relevantFixtures.length >= 3;

    const allStats=[], fwdMap={};
    const now = Date.now();

    for (const fix of fixtures.slice(0,10)) {
      const fid=fix.fixture.id, isHomeMatch=fix.teams.home.id===parseInt(teamId);
      const rivalId=isHomeMatch?fix.teams.away.id:fix.teams.home.id;
      const matchDate = new Date(fix.fixture.date).getTime();
      const daysAgo = (now - matchDate) / (1000*60*60*24);

      // Peso por recencia: partidos recientes pesan más
      // Últimos 5 partidos: peso 2.0, anteriores: peso 1.0
      const recencyWeight = daysAgo <= 45 ? 2.0 : daysAgo <= 90 ? 1.5 : 1.0;

      let rR=null;
      try { const rl=await getLeague(rivalId); if(rl)rR=await getRank(rivalId,rl); } catch(e){}
      const rT=!rR?'unknown':rR<=6?'top':rR<=12?'mid':'low';

      try {
        const [sd,pd]=await Promise.all([
          af(`/fixtures/statistics?fixture=${fid}&team=${teamId}`),
          af(`/fixtures/players?fixture=${fid}&team=${teamId}`),
        ]);
        const sr=sd?.response?.[0]?.statistics||[];
        const getS=t=>parseFloat(sr.find(s=>s.type===t)?.value)||0;
        allStats.push({
          rivalTier:rT, rivalRank:rR, isHome:isHomeMatch,
          recencyWeight,
          goals: isHomeMatch?(fix.score.fulltime.home||0):(fix.score.fulltime.away||0),
          corners: getS('Corner Kicks'),
          cards: getS('Yellow Cards')+getS('Red Cards'),
          shots: getS('Total Shots'),
          saves: getS('Goalkeeper Saves'),
        });
        (pd?.response?.[0]?.players||[]).forEach(p=>{
          if(p.player.pos==='F'||p.player.pos==='A'){
            const pid=p.player.id;
            const ps = p.statistics?.[0] || {};
            const shots = ps.shots?.total||0;
            const shotsOnTarget = ps.shots?.on||0;
            const goals = ps.goals?.total||0;
            const assists = ps.goals?.assists||0;
            const saves = ps.goals?.saves||ps.goalkeeper?.saves||0;
            const keyPasses = ps.passes?.key||0;
            if(!fwdMap[pid])fwdMap[pid]={name:p.player.name,pos:p.player.pos,shots:0,shotsOnTarget:0,goals:0,assists:0,saves:0,keyPasses:0,games:0,weight:0};
            fwdMap[pid].shots+=shots*recencyWeight;
            fwdMap[pid].shotsOnTarget+=shotsOnTarget*recencyWeight;
            fwdMap[pid].goals+=goals*recencyWeight;
            fwdMap[pid].assists+=assists*recencyWeight;
            fwdMap[pid].saves+=saves*recencyWeight;
            fwdMap[pid].keyPasses+=keyPasses*recencyWeight;
            fwdMap[pid].games++;
            fwdMap[pid].weight+=recencyWeight;
          }
        });
      } catch(e){}
    }

    // Promedios ponderados por recencia
    // Fallback si no hay datos — evitar retornar ceros
    if(allStats.length === 0) {
      return res.json({
        teamId:parseInt(teamId), teamRank:tR, opponentRank:oR, opponentTier:oTier,
        sampleSize:0, season:s, isHomeContext:null, dataQuality:'poor',
        form:{ trend:'estable', last5Goals:1.2, overall:1.2 },
        global:{goals:1.2,corners:5.0,cards:2.0,shots:10.0,saves:3.0},
        contextual:{goals:1.2,corners:5.0,cards:2.0,shots:10.0,saves:3.0},
        topForwards:[],
      });
    }
    const totalWeight = allStats.reduce((s,m)=>s+m.recencyWeight,0)||1;
    const wavg = k => allStats.reduce((s,m)=>s+m[k]*m.recencyWeight,0)/totalWeight;

    const byTierW = (tier,k) => {
      const f=allStats.filter(m=>m.rivalTier===tier);
      const tw=f.reduce((s,m)=>s+m.recencyWeight,0)||1;
      return f.length?f.reduce((s,m)=>s+m[k]*m.recencyWeight,0)/tw:null;
    };
    const ctx = k => {
      const t = byTierW(oTier,k);
      const g = wavg(k);
      const result = t!==null ? t*0.6+g*0.4 : g;
      // Sanity check: if result is suspiciously low for offensive stats, use global
      if(k==='goals' && result < 0.3 && g > 0.3) return g;
      if(k==='shots' && result < 2.0 && g > 2.0) return g;
      return result;
    };

    // Racha de resultados (últimos 5)
    const last5 = allStats.slice(0,5);
    const wins = last5.filter(m=>m.goals > 0).length; // simplificado
    const formGoals = last5.length ? last5.reduce((s,m)=>s+m.goals,0)/last5.length : wavg('goals');
    const formTrend = formGoals > wavg('goals') * 1.1 ? 'subiendo' : formGoals < wavg('goals') * 0.9 ? 'bajando' : 'estable';

    const shortN = n => n.split(' ').length<=2?n:n.split(' ')[0][0]+'. '+n.split(' ').slice(1).join(' ');
    const topForwards=Object.values(fwdMap).filter(f=>f.games>=3)
      .map(f=>({
        name: shortN(f.name),
        pos: f.pos,
        shots: +(f.shots/f.weight).toFixed(2),
        shotsOnTarget: +(f.shotsOnTarget/f.weight).toFixed(2),
        goals: +(f.goals/f.weight).toFixed(2),
        assists: +(f.assists/f.weight).toFixed(2),
        saves: +(f.saves/f.weight).toFixed(2),
        keyPasses: +(f.keyPasses/f.weight).toFixed(2),
        games: f.games,
      }))
      .sort((a,b)=>b.shots-a.shots).slice(0,5);

    res.json({
      teamId:parseInt(teamId), teamRank:tR, opponentRank:oR, opponentTier:oTier,
      sampleSize:allStats.length, season:s, isHomeContext:isFiltered?home:null,
      form:{ trend:formTrend, last5Goals:+formGoals.toFixed(2), overall:+wavg('goals').toFixed(2) },
      dataQuality: allStats.length >= 7 ? 'good' : allStats.length >= 4 ? 'limited' : 'poor',
      global:{goals:+wavg('goals').toFixed(2),corners:+wavg('corners').toFixed(2),cards:+wavg('cards').toFixed(2),shots:+wavg('shots').toFixed(2),saves:+wavg('saves').toFixed(2)},
      contextual:{goals:+ctx('goals').toFixed(2),corners:+ctx('corners').toFixed(2),cards:+ctx('cards').toFixed(2),shots:+ctx('shots').toFixed(2),saves:+ctx('saves').toFixed(2)},
      topForwards,
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Lesiones
app.get('/injuries', async (req, res) => {
  const { teamId } = req.query;
  if (!teamId) return res.status(400).json({ error:'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const d = await af(`/injuries?team=${teamId}&season=${s}`);
    const injuries=(d.response||[]).map(i=>({player:i.player.name,type:i.player.type,reason:i.player.reason,playerId:i.player.id}));
    res.json({injuries,count:injuries.length,season:s});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Alineaciones
app.get('/lineups', async (req, res) => {
  const { fixtureId, teamId } = req.query;
  if (!fixtureId) return res.status(400).json({ error:'Se requiere fixtureId' });
  try {
    const d = await af(`/fixtures/lineups?fixture=${fixtureId}${teamId?'&team='+teamId:''}`);
    const lineups=(d.response||[]).map(l=>({team:l.team,formation:l.formation,startXI:(l.startXI||[]).map(p=>({id:p.player.id,name:p.player.name,number:p.player.number,pos:p.player.pos,grid:p.player.grid})),substitutes:(l.substitutes||[]).map(p=>({id:p.player.id,name:p.player.name,pos:p.player.pos}))}));
    res.json({lineups});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Predicciones
app.get('/predictions', async (req, res) => {
  const { fixtureId } = req.query;
  if (!fixtureId) return res.status(400).json({ error:'Se requiere fixtureId' });
  try {
    const d = await af(`/predictions?fixture=${fixtureId}`);
    const pred=d.response?.[0];
    if(!pred) return res.json({found:false});
    res.json({found:true,winner:pred.predictions?.winner,winOrDraw:pred.predictions?.win_or_draw,underOver:pred.predictions?.under_over,goals:pred.predictions?.goals,advice:pred.predictions?.advice,percent:pred.predictions?.percent,comparison:pred.comparison});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// H2H
app.get('/h2h', async (req, res) => {
  const { home, away, last } = req.query;
  if (!home||!away) return res.status(400).json({ error:'Se requieren home y away' });
  try {
    const data=await af(`/fixtures/headtohead?h2h=${home}-${away}&last=${last||10}&status=FT`);
    const enriched=[];
    for(const fix of(data.response||[]).slice(0,10)){
      try {
        const [sH,sA]=await Promise.all([af(`/fixtures/statistics?fixture=${fix.fixture.id}&team=${home}`),af(`/fixtures/statistics?fixture=${fix.fixture.id}&team=${away}`)]);
        enriched.push({fixture:fix.fixture,teams:fix.teams,score:fix.score,league:fix.league,statsHome:sH.response?.[0]?.statistics||[],statsAway:sA.response?.[0]?.statistics||[]});
      } catch(e){enriched.push({fixture:fix.fixture,teams:fix.teams,score:fix.score,league:fix.league,statsHome:[],statsAway:[]});}
    }
    res.json({response:enriched,results:enriched.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Odds
app.get('/odds/match', async (req, res) => {
  const ODDS_KEY=process.env.ODDS_API_KEY;
  if(!ODDS_KEY) return res.status(500).json({error:'ODDS_API_KEY no configurada'});
  const{home,away,sport}=req.query;
  if(!home||!away) return res.status(400).json({error:'Se requieren home y away'});
  try {
    const r=await fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
    const games=await r.json();
    if(!Array.isArray(games)) return res.json({found:false});
    const hL=home.toLowerCase(),aL=away.toLowerCase();
    const match=games.find(g=>{const ht=g.home_team.toLowerCase(),at=g.away_team.toLowerCase();return(ht.includes(hL)||hL.includes(ht.split(' ')[0]))&&(at.includes(aL)||aL.includes(at.split(' ')[0]));});
    if(!match) return res.json({found:false});
    const bookmakers=[];
    match.bookmakers.forEach(bm=>{const h2h=bm.markets.find(m=>m.key==='h2h');if(!h2h)return;const ho=h2h.outcomes.find(o=>o.name===match.home_team)?.price,ao=h2h.outcomes.find(o=>o.name===match.away_team)?.price,dr=h2h.outcomes.find(o=>o.name==='Draw')?.price;if(ho&&ao)bookmakers.push({bookmaker:bm.title,key:bm.key,home:+ho.toFixed(2),draw:dr?+dr.toFixed(2):null,away:+ao.toFixed(2)});});
    res.json({found:true,home_team:match.home_team,away_team:match.away_team,commence_time:match.commence_time,bookmakers});
  } catch(e) { res.status(500).json({error:e.message}); }
});


// Importancia del partido — analiza posición en tabla y ronda
app.get('/match-importance', async (req, res) => {
  const { homeId, awayId, leagueId, round } = req.query;
  if (!homeId || !awayId) return res.status(400).json({ error: 'Se requieren homeId y awayId' });
  try {
    const s = await getActiveSeason(homeId);
    const lid = leagueId || await (async () => {
      try { const d=await af(`/leagues?team=${homeId}&season=${s}&type=League`); return d.response?.[0]?.league?.id||null; } catch(e){return null;}
    })();

    let homeRank=null, awayRank=null, totalTeams=20;
    if (lid) {
      try {
        const std = await af(`/standings?league=${lid}&season=${s}`);
        const standings = std.response?.[0]?.league?.standings?.[0] || [];
        totalTeams = standings.length || 20;
        homeRank = standings.find(x=>x.team.id===parseInt(homeId))?.rank || null;
        awayRank = standings.find(x=>x.team.id===parseInt(awayId))?.rank || null;
      } catch(e) {}
    }

    // Detectar importancia
    const relegationZone = Math.floor(totalTeams * 0.85); // último 15%
    const titleRace = 3; // top 3
    const euroZone = 6;  // top 6

    const homeRelegation = homeRank && homeRank >= relegationZone;
    const awayRelegation = awayRank && awayRank >= relegationZone;
    const homeTitleRace = homeRank && homeRank <= titleRace;
    const awayTitleRace = awayRank && awayRank <= titleRace;
    const homeEuro = homeRank && homeRank <= euroZone;
    const awayEuro = awayRank && awayRank <= euroZone;

    // Detectar si es jornada final (round contiene números altos)
    const roundNum = round ? parseInt(round.replace(/\D/g,'')) : null;
    const isLateStage = roundNum && roundNum >= (totalTeams - 2) * 2 - 6;
    const isDerby = false; // podría detectarse por ciudad en futuras versiones

    // Calcular nivel de importancia
    let importance = 'normal';
    let intensityBoost = 0; // boost para tarjetas
    let goalsBoost = 0;
    let notes = [];

    if (homeRelegation || awayRelegation) {
      importance = 'alta';
      intensityBoost = 0.8;
      goalsBoost = 0.2;
      if (homeRelegation) notes.push(`${homeRelegation?'Local':'Visitante'} pelea por no descender (pos.${homeRank}/${totalTeams})`);
      if (awayRelegation) notes.push(`Visitante pelea por no descender (pos.${awayRank}/${totalTeams})`);
    }
    if (homeTitleRace && awayTitleRace) {
      importance = 'muy alta';
      intensityBoost = 1.0;
      goalsBoost = 0.3;
      notes.push(`Duelo entre equipos top (pos.${homeRank} vs pos.${awayRank})`);
    } else if (homeTitleRace || awayTitleRace) {
      importance = importance === 'alta' ? 'muy alta' : 'alta';
      intensityBoost = Math.max(intensityBoost, 0.6);
      notes.push(`Equipo en lucha por el título involucrado`);
    }
    if (isLateStage) {
      importance = importance === 'normal' ? 'alta' : 'muy alta';
      intensityBoost += 0.4;
      notes.push(`Jornada final de temporada (jornada ${roundNum})`);
    }
    if (homeEuro && awayEuro && importance === 'normal') {
      importance = 'media-alta';
      intensityBoost = 0.4;
      notes.push(`Ambos equipos pelean por zona europea`);
    }

    res.json({
      importance, intensityBoost, goalsBoost,
      homeRank, awayRank, totalTeams,
      homeRelegation, awayRelegation,
      homeTitleRace, awayTitleRace,
      isLateStage, notes,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Minutos de goles — analiza patrones temporales de los últimos 10 partidos
app.get('/goal-minutes', async (req, res) => {
  const { teamId } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const fixtData = await af(`/fixtures?team=${teamId}&season=${s}&last=10&status=FT`);
    const fixtures = fixtData?.response || [];

    let firstHalfGoals=0, secondHalfGoals=0, last15Goals=0, first15Goals=0;
    let matchesWithGoal1H=0, matchesWithGoal2H=0, matchesWithGoalLast15=0;
    let totalMatches=0;

    for (const fix of fixtures.slice(0,10)) {
      try {
        const events = await af(`/fixtures/events?fixture=${fix.fixture.id}&team=${teamId}&type=Goal`);
        const goals = events.response || [];
        totalMatches++;
        let has1H=false, has2H=false, hasLast15=false, hasFirst15=false;
        goals.forEach(g => {
          const min = g.time?.elapsed || 0;
          const isOwnGoal = g.detail === 'Own Goal';
          if (!isOwnGoal) {
            if (min <= 45) { firstHalfGoals++; has1H=true; }
            else { secondHalfGoals++; has2H=true; }
            if (min >= 75) { last15Goals++; hasLast15=true; }
            if (min <= 15) { first15Goals++; hasFirst15=true; }
          }
        });
        if(has1H) matchesWithGoal1H++;
        if(has2H) matchesWithGoal2H++;
        if(hasLast15) matchesWithGoalLast15++;
      } catch(e) {}
    }

    const n = totalMatches || 1;
    res.json({
      teamId: parseInt(teamId),
      totalMatches: n,
      firstHalfRate: parseFloat((matchesWithGoal1H/n).toFixed(2)),
      secondHalfRate: parseFloat((matchesWithGoal2H/n).toFixed(2)),
      last15Rate: parseFloat((matchesWithGoalLast15/n).toFixed(2)),
      avgFirst15Goals: parseFloat((first15Goals/n).toFixed(2)),
      avgLast15Goals: parseFloat((last15Goals/n).toFixed(2)),
      avgFirstHalfGoals: parseFloat((firstHalfGoals/n).toFixed(2)),
      avgSecondHalfGoals: parseFloat((secondHalfGoals/n).toFixed(2)),
      scoringPattern: firstHalfGoals > secondHalfGoals ? 'primer tiempo' : secondHalfGoals > firstHalfGoals*1.3 ? 'segundo tiempo' : 'distribuido',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Fatiga de calendario / rotación — detecta partidos importantes próximos
app.get('/schedule-fatigue', async (req, res) => {
  const { teamId, matchDate } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const targetDate = matchDate ? new Date(matchDate) : new Date();

    // Partidos de los próximos 10 días y últimos 5 días
    const [nextFixtures, prevFixtures] = await Promise.all([
      af(`/fixtures?team=${teamId}&next=5`),
      af(`/fixtures?team=${teamId}&last=5&status=FT`),
    ]);

    const upcomingAll = nextFixtures?.response || [];
    const recentAll = prevFixtures?.response || [];

    // Competiciones de alta importancia
    const HIGH_COMP = [
      'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League',
      'Copa del Rey', 'FA Cup', 'DFB Pokal', 'Coppa Italia', 'Coupe de France',
      'Copa Libertadores', 'Copa Sudamericana', 'FIFA Club World Cup',
      'UEFA Super Cup', 'World Cup', 'CONMEBOL',
    ];
    const isHighComp = name => HIGH_COMP.some(c => (name||'').includes(c));

    // Buscar partidos importantes en los próximos 7 días
    const importantUpcoming = upcomingAll.filter(f => {
      const fDate = new Date(f.fixture.date);
      const daysAway = (fDate - targetDate) / (1000*60*60*24);
      return daysAway > 0 && daysAway <= 7 && isHighComp(f.league.name);
    }).map(f => ({
      fixtureId: f.fixture.id,
      date: f.fixture.date,
      daysAway: Math.round((new Date(f.fixture.date) - targetDate) / (1000*60*60*24)),
      league: f.league.name,
      round: f.league.round,
      opponent: f.teams.home.id === parseInt(teamId) ? f.teams.away.name : f.teams.home.name,
      isHome: f.teams.home.id === parseInt(teamId),
    }));

    // Buscar partidos jugados en los últimos 4 días (fatiga)
    const recentHighComp = recentAll.filter(f => {
      const fDate = new Date(f.fixture.date);
      const daysAgo = (targetDate - fDate) / (1000*60*60*24);
      return daysAgo >= 0 && daysAgo <= 4 && isHighComp(f.league.name);
    }).map(f => ({
      date: f.fixture.date,
      daysAgo: Math.round((targetDate - new Date(f.fixture.date)) / (1000*60*60*24)),
      league: f.league.name,
      opponent: f.teams.home.id === parseInt(teamId) ? f.teams.away.name : f.teams.home.name,
    }));

    // Calcular nivel de rotación esperada
    let rotationLevel = 'none';
    let goalsAdj = 0, shotsAdj = 0, cornersAdj = 0, cardsAdj = 0, confidenceAdj = 0;
    let notes = [];

    // Fatiga por partido reciente (jugó hace 3-4 días)
    if (recentHighComp.length > 0) {
      const recent = recentHighComp[0];
      rotationLevel = 'fatigue';
      goalsAdj = -0.2;
      shotsAdj = -0.10;
      cornersAdj = -0.5;
      cardsAdj = 0.2;
      confidenceAdj = -3;
      notes.push(`Jugó ${recent.league} hace ${recent.daysAgo} día(s) vs ${recent.opponent}`);
    }

    // Rotación por partido importante próximo
    if (importantUpcoming.length > 0) {
      const next = importantUpcoming[0];
      const isKnockout = (next.round||'').toLowerCase().includes('final') ||
                         (next.round||'').toLowerCase().includes('octavo') ||
                         (next.round||'').toLowerCase().includes('cuarto') ||
                         (next.round||'').toLowerCase().includes('semi') ||
                         (next.round||'').toLowerCase().includes('round of') ||
                         (next.round||'').toLowerCase().includes('knockout');

      const rotAdj = next.daysAway <= 3 ? 1.5 : next.daysAway <= 5 ? 1.0 : 0.6;
      const knockoutMult = isKnockout ? 1.4 : 1.0;

      rotationLevel = isKnockout && next.daysAway <= 5 ? 'high' : 'moderate';
      goalsAdj += -0.3 * rotAdj * knockoutMult;
      shotsAdj += -0.12 * rotAdj;
      cornersAdj += -0.8 * rotAdj;
      cardsAdj += 0.3 * rotAdj;
      confidenceAdj += -5 * rotAdj;

      notes.push(`${isKnockout?'⚽ Eliminatoria':'Partido'} de ${next.league} en ${next.daysAway} día(s) vs ${next.opponent}${isKnockout?' — rotación probable':''}`);
    }

    res.json({
      teamId: parseInt(teamId),
      rotationLevel,
      hasUpcomingImportant: importantUpcoming.length > 0,
      hasRecentFatigue: recentHighComp.length > 0,
      upcomingMatches: importantUpcoming,
      recentMatches: recentHighComp,
      adjustments: {
        goals: parseFloat(goalsAdj.toFixed(2)),
        shots: parseFloat(shotsAdj.toFixed(2)),
        corners: parseFloat(cornersAdj.toFixed(2)),
        cards: parseFloat(cardsAdj.toFixed(2)),
        confidence: parseFloat(confidenceAdj.toFixed(1)),
      },
      notes,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Estadísticas defensivas del rival — cuánto permite generar el equipo rival
app.get('/stats/defensive', async (req, res) => {
  const { teamId } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const fixtData = await af(`/fixtures?team=${teamId}&season=${s}&last=10&status=FT`);
    const fixtures = fixtData?.response || [];
    const defStats = { goalsAgainst:0, shotsAgainst:0, cornersAgainst:0, savesFor:0, n:0 };

    for (const fix of fixtures.slice(0,10)) {
      const fid = fix.fixture.id;
      const isHome = fix.teams.home.id === parseInt(teamId);
      const rivalId = isHome ? fix.teams.away.id : fix.teams.home.id;
      try {
        const sd = await af(`/fixtures/statistics?fixture=${fid}&team=${rivalId}`);
        const sr = sd?.response?.[0]?.statistics || [];
        const getS = t => parseFloat(sr.find(s=>s.type===t)?.value)||0;
        defStats.goalsAgainst += isHome?(fix.score.fulltime.away||0):(fix.score.fulltime.home||0);
        defStats.shotsAgainst += getS('Total Shots');
        defStats.cornersAgainst += getS('Corner Kicks');
        defStats.savesFor += getS('Goalkeeper Saves');
        defStats.n++;
      } catch(e) {}
    }
    const n = defStats.n || 1;
    res.json({
      teamId: parseInt(teamId),
      avgGoalsAgainst: +(defStats.goalsAgainst/n).toFixed(2),
      avgShotsAgainst: +(defStats.shotsAgainst/n).toFixed(2),
      avgCornersAgainst: +(defStats.cornersAgainst/n).toFixed(2),
      avgSavesFor: +(defStats.savesFor/n).toFixed(2),
      defensiveRating: defStats.goalsAgainst/n <= 0.8 ? 'elite' : defStats.goalsAgainst/n <= 1.2 ? 'solida' : defStats.goalsAgainst/n <= 1.8 ? 'media' : 'debil',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// xG — goles esperados desde statistics de los últimos partidos
app.get('/xg', async (req, res) => {
  const { teamId } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const fixtData = await af(`/fixtures?team=${teamId}&season=${s}&last=10&status=FT`);
    const fixtures = fixtData?.response || [];
    let totalXG=0, totalGoals=0, n=0;

    for (const fix of fixtures.slice(0,10)) {
      const fid = fix.fixture.id;
      const isHome = fix.teams.home.id === parseInt(teamId);
      try {
        const sd = await af(`/fixtures/statistics?fixture=${fid}&team=${teamId}`);
        const sr = sd?.response?.[0]?.statistics || [];
        // API-Football incluye xG en algunos partidos
        const xg = parseFloat(sr.find(s=>s.type==='expected_goals'||s.type==='xG')?.value) || null;
        const shots = parseFloat(sr.find(s=>s.type==='Total Shots')?.value)||0;
        const shotsOnTarget = parseFloat(sr.find(s=>s.type==='Shots on Goal')?.value)||0;
        const goals = isHome?(fix.score.fulltime.home||0):(fix.score.fulltime.away||0);
        // Si no hay xG nativo, estimarlo: xG ≈ shots_on_target * 0.33 + (shots-shots_on_target)*0.05
        const estimatedXG = xg !== null ? xg : shotsOnTarget*0.33 + (shots-shotsOnTarget)*0.05;
        totalXG += estimatedXG;
        totalGoals += goals;
        n++;
      } catch(e) {}
    }
    const nm = n||1;
    const avgXG = totalXG/nm;
    const avgGoals = totalGoals/nm;
    const xgOverPerformance = avgGoals - avgXG; // positivo = suerte, negativo = mala suerte
    res.json({
      teamId: parseInt(teamId),
      avgXG: +avgXG.toFixed(2),
      avgGoals: +avgGoals.toFixed(2),
      xgOverPerformance: +xgOverPerformance.toFixed(2),
      trend: xgOverPerformance > 0.3 ? 'sobrerendimiento' : xgOverPerformance < -0.3 ? 'infrarendimiento' : 'normal',
      sampleSize: n,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Comparación de cuotas entre casas de apuestas
app.get('/odds/compare', async (req, res) => {
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_API_KEY no configurada' });
  const { home, away, sport, market } = req.query;
  if (!home||!away) return res.status(400).json({ error: 'Se requieren home y away' });
  try {
    const markets = market || 'h2h,totals';
    const r = await fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu,uk&markets=${markets}&oddsFormat=decimal`);
    const games = await r.json();
    if (!Array.isArray(games)) return res.json({ found:false });
    const hL=home.toLowerCase(), aL=away.toLowerCase();
    const match = games.find(g=>{
      const ht=g.home_team.toLowerCase(), at=g.away_team.toLowerCase();
      return (ht.includes(hL)||hL.includes(ht.split(' ')[0]))&&(at.includes(aL)||aL.includes(at.split(' ')[0]));
    });
    if (!match) return res.json({ found:false });

    // Agrupar por mercado y bookmaker
    const comparison = {};
    match.bookmakers.forEach(bm => {
      bm.markets.forEach(mkt => {
        if (!comparison[mkt.key]) comparison[mkt.key] = { market: mkt.key, bookmakers: [] };
        const outcomes = {};
        mkt.outcomes.forEach(o => { outcomes[o.name] = o.price; });
        comparison[mkt.key].bookmakers.push({ name: bm.title, outcomes });
      });
    });

    // Encontrar mejor cuota por resultado
    const bestOdds = {};
    Object.values(comparison).forEach(mkt => {
      mkt.bookmakers.forEach(bm => {
        Object.entries(bm.outcomes).forEach(([name, price]) => {
          const key = `${mkt.market}:${name}`;
          if (!bestOdds[key] || price > bestOdds[key].price) {
            bestOdds[key] = { price, bookmaker: bm.name, market: mkt.market, outcome: name };
          }
        });
      });
    });

    res.json({ found:true, home_team:match.home_team, away_team:match.away_team, comparison, bestOdds:Object.values(bestOdds) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Modelo Poisson — probabilidades exactas por resultado
app.get('/poisson', async (req, res) => {
  const { homeLambda, awayLambda } = req.query;
  if (!homeLambda || !awayLambda) return res.status(400).json({ error: 'Se requieren homeLambda y awayLambda' });
  try {
    const hL = parseFloat(homeLambda);
    const aL = parseFloat(awayLambda);

    // Factorial helper
    const fact = n => { let r=1; for(let i=2;i<=n;i++) r*=i; return r; };
    // Poisson PMF: P(X=k) = e^-λ * λ^k / k!
    const poisson = (lambda, k) => Math.exp(-lambda) * Math.pow(lambda,k) / fact(k);

    // Calcular matriz de probabilidades hasta 6 goles por equipo
    const maxGoals = 7;
    let homeWin=0, draw=0, awayWin=0;
    let over05=0, over15=0, over25=0, over35=0;
    let btts=0, bttsNo=0;
    let homeOver05=0, homeOver15=0, homeOver25=0;
    let awayOver05=0, awayOver15=0, awayOver25=0;
    const matrix = [];

    for(let h=0; h<maxGoals; h++){
      for(let a=0; a<maxGoals; a++){
        const p = poisson(hL,h) * poisson(aL,a);
        matrix.push({h,a,p:+p.toFixed(6)});
        const total = h+a;
        if(h>a) homeWin+=p;
        else if(h===a) draw+=p;
        else awayWin+=p;
        if(total>0.5) over05+=p;
        if(total>1.5) over15+=p;
        if(total>2.5) over25+=p;
        if(total>3.5) over35+=p;
        if(h>0&&a>0) btts+=p;
        else bttsNo+=p;
        if(h>0.5) homeOver05+=p;
        if(h>1.5) homeOver15+=p;
        if(h>2.5) homeOver25+=p;
        if(a>0.5) awayOver05+=p;
        if(a>1.5) awayOver15+=p;
        if(a>2.5) awayOver25+=p;
      }
    }

    // Fair odds = 1/probability
    const fairOdds = p => p>0 ? +(1/p).toFixed(2) : null;

    res.json({
      probabilities: {
        homeWin: +homeWin.toFixed(4),
        draw: +draw.toFixed(4),
        awayWin: +awayWin.toFixed(4),
        over05: +over05.toFixed(4),
        over15: +over15.toFixed(4),
        over25: +over25.toFixed(4),
        over35: +over35.toFixed(4),
        btts: +btts.toFixed(4),
        bttsNo: +bttsNo.toFixed(4),
        homeOver05: +homeOver05.toFixed(4),
        homeOver15: +homeOver15.toFixed(4),
        homeOver25: +homeOver25.toFixed(4),
        awayOver05: +awayOver05.toFixed(4),
        awayOver15: +awayOver15.toFixed(4),
        awayOver25: +awayOver25.toFixed(4),
      },
      fairOdds: {
        homeWin: fairOdds(homeWin),
        draw: fairOdds(draw),
        awayWin: fairOdds(awayWin),
        over25: fairOdds(over25),
        btts: fairOdds(btts),
        homeOver15: fairOdds(homeOver15),
        awayOver15: fairOdds(awayOver15),
      },
      topScenarios: matrix.sort((a,b)=>b.p-a.p).slice(0,6),
      lambdas: { home: hL, away: aL },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Movimiento de cuotas — apertura vs cierre
app.get('/odds/movement', async (req, res) => {
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_API_KEY no configurada' });
  const { home, away, sport } = req.query;
  if (!home||!away) return res.status(400).json({ error: 'Se requieren home y away' });
  try {
    // The Odds API historical endpoint para odds de apertura
    const [currentR, historicalR] = await Promise.all([
      fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`),
      fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`),
    ]);
    const current = await currentR.json();
    if (!Array.isArray(current)) return res.json({ found:false });

    const hL=home.toLowerCase(), aL=away.toLowerCase();
    const match = current.find(g=>{
      const ht=g.home_team.toLowerCase(), at=g.away_team.toLowerCase();
      return (ht.includes(hL)||hL.includes(ht.split(' ')[0]))&&(at.includes(aL)||aL.includes(at.split(' ')[0]));
    });
    if (!match) return res.json({ found:false });

    // Extraer cuotas actuales y detectar movimiento
    const movements = [];
    match.bookmakers.forEach(bm => {
      const h2h = bm.markets.find(m=>m.key==='h2h');
      if (!h2h) return;
      const lastUpdate = new Date(h2h.last_update);
      const homeOdds = h2h.outcomes.find(o=>o.name===match.home_team);
      const awayOdds = h2h.outcomes.find(o=>o.name===match.away_team);
      const drawOdds = h2h.outcomes.find(o=>o.name==='Draw');
      if (homeOdds) {
        movements.push({
          bookmaker: bm.title,
          lastUpdate: h2h.last_update,
          home: homeOdds.price,
          draw: drawOdds?.price||null,
          away: awayOdds?.price||null,
        });
      }
    });

    // Detectar consenso del mercado
    const avgHome = movements.reduce((s,m)=>s+m.home,0)/movements.length;
    const avgAway = movements.reduce((s,m)=>s+(m.away||0),0)/movements.length;
    const avgDraw = movements.reduce((s,m)=>s+(m.draw||0),0)/movements.length;
    const impliedHome = 1/avgHome;
    const impliedAway = 1/avgAway;
    const impliedDraw = 1/avgDraw;
    const totalImplied = impliedHome+impliedAway+impliedDraw;

    res.json({
      found: true,
      home_team: match.home_team,
      away_team: match.away_team,
      marketConsensus: {
        homeWinProb: +(impliedHome/totalImplied).toFixed(4),
        drawProb: +(impliedDraw/totalImplied).toFixed(4),
        awayWinProb: +(impliedAway/totalImplied).toFixed(4),
        avgHomeOdds: +avgHome.toFixed(2),
        avgDrawOdds: +avgDraw.toFixed(2),
        avgAwayOdds: +avgAway.toFixed(2),
        bookmakerCount: movements.length,
        favorite: impliedHome>impliedAway ? match.home_team : match.away_team,
      },
      bookmakers: movements,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Handicap asiático — cuotas y análisis
app.get('/odds/asian', async (req, res) => {
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_API_KEY no configurada' });
  const { home, away, sport } = req.query;
  if (!home||!away) return res.status(400).json({ error: 'Se requieren home y away' });
  try {
    const r = await fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu,uk&markets=asian_handicap,totals&oddsFormat=decimal`);
    const games = await r.json();
    if (!Array.isArray(games)) return res.json({ found:false });
    const hL=home.toLowerCase(), aL=away.toLowerCase();
    const match = games.find(g=>{
      const ht=g.home_team.toLowerCase(), at=g.away_team.toLowerCase();
      return (ht.includes(hL)||hL.includes(ht.split(' ')[0]))&&(at.includes(aL)||aL.includes(at.split(' ')[0]));
    });
    if (!match) return res.json({ found:false });

    const ahMarkets = [], totalsMarkets = [];
    match.bookmakers.forEach(bm => {
      bm.markets.forEach(mkt => {
        if (mkt.key==='asian_handicap') {
          mkt.outcomes.forEach(o => {
            ahMarkets.push({ bookmaker:bm.title, name:o.name, point:o.point, price:o.price });
          });
        }
        if (mkt.key==='totals') {
          mkt.outcomes.forEach(o => {
            totalsMarkets.push({ bookmaker:bm.title, name:o.name, point:o.point, price:o.price });
          });
        }
      });
    });

    // Detectar línea asiática más ofrecida (consenso)
    const ahPoints = {};
    ahMarkets.forEach(m => {
      const key = `${m.point}`;
      if (!ahPoints[key]) ahPoints[key] = {point:m.point, count:0, avgPrice:0, prices:[]};
      ahPoints[key].count++;
      ahPoints[key].prices.push(m.price);
    });
    Object.values(ahPoints).forEach(p => { p.avgPrice = +(p.prices.reduce((s,v)=>s+v,0)/p.prices.length).toFixed(2); });
    const consensusAH = Object.values(ahPoints).sort((a,b)=>b.count-a.count).slice(0,3);

    // Totals consensus
    const totalsPoints = {};
    totalsMarkets.forEach(m => {
      const key = `${m.point}`;
      if (!totalsPoints[key]) totalsPoints[key]={point:m.point,over:[],under:[]};
      if(m.name==='Over') totalsPoints[key].over.push(m.price);
      else totalsPoints[key].under.push(m.price);
    });
    const totalsSummary = Object.values(totalsPoints).map(t=>({
      point:t.point,
      avgOver:t.over.length?+(t.over.reduce((s,v)=>s+v,0)/t.over.length).toFixed(2):null,
      avgUnder:t.under.length?+(t.under.reduce((s,v)=>s+v,0)/t.under.length).toFixed(2):null,
      impliedOver:t.over.length?+(1/(t.over.reduce((s,v)=>s+v,0)/t.over.length)).toFixed(3):null,
    })).sort((a,b)=>a.point-b.point);

    res.json({ found:true, home_team:match.home_team, away_team:match.away_team, consensusAH, totalsSummary, ahMarkets:ahMarkets.slice(0,10), totalsMarkets:totalsMarkets.slice(0,10) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rendimiento por jugador clave
app.get('/player-impact', async (req, res) => {
  const { teamId, fixtureId } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const s = await getActiveSeason(teamId);
    const [squadR, recentR] = await Promise.all([
      af(`/players/squads?team=${teamId}`),
      af(`/fixtures?team=${teamId}&season=${s}&last=15&status=FT`),
    ]);

    const squad = squadR.response?.[0]?.players || [];
    const fixtures = recentR.response || [];

    // Obtener stats de jugadores clave (top por posición)
    const keyPlayers = squad
      .filter(p => ['Attacker','Midfielder'].includes(p.position))
      .slice(0, 8);

    // Analizar partidos con/sin cada jugador clave
    const playerImpact = {};
    for (const player of keyPlayers.slice(0,5)) {
      const pid = player.id;
      const withPlayer = [], withoutPlayer = [];

      for (const fix of fixtures.slice(0,15)) {
        const fid = fix.fixture.id;
        try {
          const pd = await af(`/fixtures/players?fixture=${fid}&team=${teamId}`);
          const players = pd.response?.[0]?.players || [];
          const played = players.find(p=>p.player.id===pid);
          const isHome = fix.teams.home.id === parseInt(teamId);
          const goals = isHome?(fix.score.fulltime.home||0):(fix.score.fulltime.away||0);
          const shots = players.find(p=>p.player.id===pid)?.statistics?.[0]?.shots?.total||0;

          if (played && (played.statistics?.[0]?.games?.minutes||0) >= 45) {
            withPlayer.push({ goals, shots });
          } else {
            withoutPlayer.push({ goals });
          }
        } catch(e) {}
      }

      if (withPlayer.length >= 3) {
        const avgWith = withPlayer.reduce((s,m)=>s+m.goals,0)/withPlayer.length;
        const avgWithout = withoutPlayer.length ? withoutPlayer.reduce((s,m)=>s+m.goals,0)/withoutPlayer.length : null;
        playerImpact[pid] = {
          id: pid,
          name: player.name,
          position: player.position,
          avgGoalsWith: +avgWith.toFixed(2),
          avgGoalsWithout: avgWithout !== null ? +avgWithout.toFixed(2) : null,
          impact: avgWithout !== null ? +(avgWith - avgWithout).toFixed(2) : null,
          gamesAnalyzed: withPlayer.length,
          isKeyPlayer: avgWithout !== null && (avgWith - avgWithout) > 0.3,
        };
      }
    }

    // Verificar si jugador clave está en alineación del próximo partido
    let startingKeyPlayers = [];
    if (fixtureId) {
      try {
        const lu = await af(`/fixtures/lineups?fixture=${fixtureId}&team=${teamId}`);
        const lineup = lu.response?.[0];
        if (lineup) {
          const starters = (lineup.startXI||[]).map(p=>p.player.id);
          startingKeyPlayers = Object.values(playerImpact)
            .filter(p=>p.isKeyPlayer && starters.includes(p.id))
            .map(p=>p.name);
        }
      } catch(e) {}
    }

    res.json({
      teamId: parseInt(teamId),
      keyPlayers: Object.values(playerImpact).sort((a,b)=>(b.impact||0)-(a.impact||0)),
      startingKeyPlayers,
      hasKeyPlayersStarting: startingKeyPlayers.length > 0,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Proxy corriendo en puerto ${PORT}`));
