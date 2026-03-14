const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const AF = 'https://v3.football.api-sports.io';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

app.use(cors());
app.use(express.json());

async function af(path) {
  const KEY = process.env.API_FOOTBALL_KEY;
  const r = await fetch(`${AF}${path}`, { headers: { 'x-apisports-key': KEY, 'Accept': 'application/json' } });
  return r.json();
}

app.get('/', (req, res) => res.json({ status: 'ok', football_key: !!process.env.API_FOOTBALL_KEY, odds_key: !!process.env.ODDS_API_KEY }));

// Proxy genérico
app.get('/api/*', async (req, res) => {
  if (!process.env.API_FOOTBALL_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY no configurada' });
  const path = req.path.replace('/api', '');
  const query = new URLSearchParams(req.query).toString();
  try {
    const r = await fetch(`${AF}${path}${query ? '?' + query : ''}`, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY, 'Accept': 'application/json' } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Partidos próximos de una liga (próximos 7 días + en vivo + hoy)
app.get('/fixtures/upcoming', async (req, res) => {
  const { leagueId, season } = req.query;
  if (!leagueId) return res.status(400).json({ error: 'Se requiere leagueId' });
  const s = season || '2024';

  try {
    // Fecha actual y +7 días
    const now = new Date();
    const from = now.toISOString().split('T')[0];
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const d = await af(`/fixtures?league=${leagueId}&season=${s}&from=${from}&to=${to}&status=NS-1H-2H-HT`);
    const fixtures = (d.response || []).slice(0, 20);

    const result = fixtures.map(f => ({
      fixtureId: f.fixture.id,
      date: f.fixture.date,
      timestamp: f.fixture.timestamp,
      status: f.fixture.status,
      venue: f.fixture.venue?.name,
      home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
      away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
      score: f.goals,
      round: f.league.round,
    }));

    res.json({ fixtures: result, count: result.length, from, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lesiones
app.get('/injuries', async (req, res) => {
  const { teamId, season } = req.query;
  if (!teamId) return res.status(400).json({ error: 'Se requiere teamId' });
  try {
    const d = await af(`/injuries?team=${teamId}&season=${season || '2024'}`);
    const injuries = (d.response || []).map(i => ({ player: i.player.name, type: i.player.type, reason: i.player.reason, playerId: i.player.id }));
    res.json({ injuries, count: injuries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alineaciones
app.get('/lineups', async (req, res) => {
  const { fixtureId, teamId } = req.query;
  if (!fixtureId) return res.status(400).json({ error: 'Se requiere fixtureId' });
  try {
    const d = await af(`/fixtures/lineups?fixture=${fixtureId}${teamId ? '&team=' + teamId : ''}`);
    const lineups = (d.response || []).map(l => ({
      team: l.team, formation: l.formation,
      startXI: (l.startXI || []).map(p => ({ id: p.player.id, name: p.player.name, number: p.player.number, pos: p.player.pos, grid: p.player.grid })),
      substitutes: (l.substitutes || []).map(p => ({ id: p.player.id, name: p.player.name, pos: p.player.pos })),
    }));
    res.json({ lineups });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Próximo fixture entre dos equipos
app.get('/next-fixture', async (req, res) => {
  const { homeId, awayId } = req.query;
  if (!homeId || !awayId) return res.status(400).json({ error: 'Se requieren homeId y awayId' });
  try {
    const d = await af(`/fixtures/headtohead?h2h=${homeId}-${awayId}&next=1`);
    const fixture = d.response?.[0];
    if (!fixture) return res.json({ found: false });
    res.json({ found: true, fixtureId: fixture.fixture.id, date: fixture.fixture.date, venue: fixture.fixture.venue?.name, league: fixture.league });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Predicciones
app.get('/predictions', async (req, res) => {
  const { fixtureId } = req.query;
  if (!fixtureId) return res.status(400).json({ error: 'Se requiere fixtureId' });
  try {
    const d = await af(`/predictions?fixture=${fixtureId}`);
    const pred = d.response?.[0];
    if (!pred) return res.json({ found: false });
    res.json({ found: true, winner: pred.predictions?.winner, winOrDraw: pred.predictions?.win_or_draw, underOver: pred.predictions?.under_over, goals: pred.predictions?.goals, advice: pred.predictions?.advice, percent: pred.predictions?.percent, comparison: pred.comparison });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stats avanzadas contextuales
app.get('/stats/advanced', async (req, res) => {
  if (!process.env.API_FOOTBALL_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY no configurada' });
  const { teamId, opponentId, season } = req.query;
  if (!teamId || !opponentId) return res.status(400).json({ error: 'Se requieren teamId y opponentId' });
  const s = season || '2024';
  try {
    const getLeague = async tid => { try { const d=await af(`/leagues?team=${tid}&season=${s}&type=League`); return d.response?.[0]?.league?.id||null; } catch(e){return null;} };
    const getRank = async (tid,lid) => { if(!lid)return null; try { const d=await af(`/standings?league=${lid}&season=${s}&team=${tid}`); const st=d.response?.[0]?.league?.standings?.[0]||[]; return st.find(x=>x.team.id===parseInt(tid))?.rank||null; } catch(e){return null;} };
    const [tL,oL]=await Promise.all([getLeague(teamId),getLeague(opponentId)]);
    const [tR,oR]=await Promise.all([getRank(teamId,tL),getRank(opponentId,oL)]);
    const oTier=!oR?'unknown':oR<=6?'top':oR<=12?'mid':'low';
    const fixtData=await af(`/fixtures?team=${teamId}&season=${s}&last=10&status=FT`);
    const fixtures=fixtData?.response||[];
    const allStats=[],fwdMap={};
    for(const fix of fixtures.slice(0,10)){
      const fid=fix.fixture.id,isHome=fix.teams.home.id===parseInt(teamId);
      const rivalId=isHome?fix.teams.away.id:fix.teams.home.id;
      let rR=null;
      try{const rl=await getLeague(rivalId);if(rl)rR=await getRank(rivalId,rl);}catch(e){}
      const rT=!rR?'unknown':rR<=6?'top':rR<=12?'mid':'low';
      try{
        const [sd,pd]=await Promise.all([af(`/fixtures/statistics?fixture=${fid}&team=${teamId}`),af(`/fixtures/players?fixture=${fid}&team=${teamId}`)]);
        const sr=sd?.response?.[0]?.statistics||[];
        const getS=t=>parseFloat(sr.find(s=>s.type===t)?.value)||0;
        allStats.push({rivalTier:rT,rivalRank:rR,isHome,goals:isHome?(fix.score.fulltime.home||0):(fix.score.fulltime.away||0),corners:getS('Corner Kicks'),cards:getS('Yellow Cards')+getS('Red Cards'),shots:getS('Total Shots'),saves:getS('Goalkeeper Saves')});
        (pd?.response?.[0]?.players||[]).forEach(p=>{
          if(p.player.pos==='F'||p.player.pos==='A'){const pid=p.player.id,shots=p.statistics?.[0]?.shots?.total||0,goals=p.statistics?.[0]?.goals?.total||0;if(!fwdMap[pid])fwdMap[pid]={name:p.player.name,shots:0,goals:0,games:0};fwdMap[pid].shots+=shots;fwdMap[pid].goals+=goals;fwdMap[pid].games++;}
        });
      }catch(e){}
    }
    const n=allStats.length||1;
    const avg=k=>allStats.reduce((s,m)=>s+(m[k]||0),0)/n;
    const byTier=(tier,k)=>{const f=allStats.filter(m=>m.rivalTier===tier);return f.length?f.reduce((s,m)=>s+(m[k]||0),0)/f.length:null;};
    const ctx=k=>{const t=byTier(oTier,k),g=avg(k);return t!==null?t*0.6+g*0.4:g;};
    const topForwards=Object.values(fwdMap).filter(f=>f.games>=3).map(f=>{const p=f.name.split(' ');return{name:p.length<=2?f.name:p[0][0]+'. '+p.slice(1).join(' '),shots:f.shots/f.games,goals:f.goals/f.games};}).sort((a,b)=>b.shots-a.shots).slice(0,3);
    res.json({teamId:parseInt(teamId),teamRank:tR,opponentRank:oR,opponentTier:oTier,sampleSize:n,global:{goals:+avg('goals').toFixed(2),corners:+avg('corners').toFixed(2),cards:+avg('cards').toFixed(2),shots:+avg('shots').toFixed(2),saves:+avg('saves').toFixed(2)},contextual:{goals:+ctx('goals').toFixed(2),corners:+ctx('corners').toFixed(2),cards:+ctx('cards').toFixed(2),shots:+ctx('shots').toFixed(2),saves:+ctx('saves').toFixed(2)},byTier:{top:{goals:byTier('top','goals'),shots:byTier('top','shots'),saves:byTier('top','saves')},mid:{goals:byTier('mid','goals'),shots:byTier('mid','shots'),saves:byTier('mid','saves')},low:{goals:byTier('low','goals'),shots:byTier('low','shots'),saves:byTier('low','saves')}},topForwards});
  }catch(e){res.status(500).json({error:e.message});}
});

// H2H
app.get('/h2h', async (req, res) => {
  const { home, away, last } = req.query;
  if (!home||!away) return res.status(400).json({ error: 'Se requieren home y away' });
  try {
    const data=await af(`/fixtures/headtohead?h2h=${home}-${away}&last=${last||10}&status=FT`);
    const enriched=[];
    for(const fix of(data.response||[]).slice(0,10)){
      try{const [sH,sA]=await Promise.all([af(`/fixtures/statistics?fixture=${fix.fixture.id}&team=${home}`),af(`/fixtures/statistics?fixture=${fix.fixture.id}&team=${away}`)]);enriched.push({fixture:fix.fixture,teams:fix.teams,score:fix.score,league:fix.league,statsHome:sH.response?.[0]?.statistics||[],statsAway:sA.response?.[0]?.statistics||[]});}
      catch(e){enriched.push({fixture:fix.fixture,teams:fix.teams,score:fix.score,league:fix.league,statsHome:[],statsAway:[]});}
    }
    res.json({response:enriched,results:enriched.length});
  }catch(e){res.status(500).json({error:e.message});}
});

// Odds
app.get('/odds/match', async (req, res) => {
  const ODDS_KEY=process.env.ODDS_API_KEY;
  if(!ODDS_KEY)return res.status(500).json({error:'ODDS_API_KEY no configurada'});
  const{home,away,sport}=req.query;
  if(!home||!away)return res.status(400).json({error:'Se requieren home y away'});
  try{
    const r=await fetch(`${ODDS_BASE}/sports/${sport||'soccer_epl'}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
    const games=await r.json();
    if(!Array.isArray(games))return res.json({found:false});
    const hL=home.toLowerCase(),aL=away.toLowerCase();
    const match=games.find(g=>{const ht=g.home_team.toLowerCase(),at=g.away_team.toLowerCase();return(ht.includes(hL)||hL.includes(ht.split(' ')[0]))&&(at.includes(aL)||aL.includes(at.split(' ')[0]));});
    if(!match)return res.json({found:false});
    const bookmakers=[];
    match.bookmakers.forEach(bm=>{const h2h=bm.markets.find(m=>m.key==='h2h');if(!h2h)return;const ho=h2h.outcomes.find(o=>o.name===match.home_team)?.price,ao=h2h.outcomes.find(o=>o.name===match.away_team)?.price,dr=h2h.outcomes.find(o=>o.name==='Draw')?.price;if(ho&&ao)bookmakers.push({bookmaker:bm.title,key:bm.key,home:+ho.toFixed(2),draw:dr?+dr.toFixed(2):null,away:+ao.toFixed(2)});});
    res.json({found:true,home_team:match.home_team,away_team:match.away_team,commence_time:match.commence_time,bookmakers});
  }catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT, () => console.log(`Proxy corriendo en puerto ${PORT}`));
