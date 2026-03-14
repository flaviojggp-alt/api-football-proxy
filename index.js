const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

app.use(cors());
app.use(express.json());

console.log('API_FOOTBALL_KEY presente:', !!process.env.API_FOOTBALL_KEY);
console.log('ODDS_API_KEY presente:', !!process.env.ODDS_API_KEY);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'API-Football + Odds Proxy activo',
    football_key: !!process.env.API_FOOTBALL_KEY,
    odds_key: !!process.env.ODDS_API_KEY,
  });
});

// Proxy API-Football — reenvía cualquier ruta
app.get('/api/*', async (req, res) => {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY no configurada' });
  const path = req.path.replace('/api', '');
  const query = new URLSearchParams(req.query).toString();
  const url = `${API_FOOTBALL_BASE}${path}${query ? '?' + query : ''}`;
  try {
    const response = await fetch(url, {
      headers: { 'x-apisports-key': API_KEY, 'Accept': 'application/json' },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error API-Football', detail: err.message });
  }
});

// Head to Head — estadísticas de enfrentamientos directos
app.get('/h2h', async (req, res) => {
  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API_FOOTBALL_KEY no configurada' });
  const { home, away, last } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'Se requieren home y away (IDs)' });
  const url = `${API_FOOTBALL_BASE}/fixtures/headtohead?h2h=${home}-${away}&last=${last||10}&status=FT`;
  try {
    const response = await fetch(url, {
      headers: { 'x-apisports-key': API_KEY, 'Accept': 'application/json' },
    });
    const data = await response.json();
    // Enriquecer con estadísticas por partido
    const fixtures = data.response || [];
    const enriched = [];
    for (const fix of fixtures.slice(0, 10)) {
      const fid = fix.fixture.id;
      try {
        const [statsHome, statsAway] = await Promise.all([
          fetch(`${API_FOOTBALL_BASE}/fixtures/statistics?fixture=${fid}&team=${home}`, {
            headers: { 'x-apisports-key': API_KEY }
          }).then(r => r.json()),
          fetch(`${API_FOOTBALL_BASE}/fixtures/statistics?fixture=${fid}&team=${away}`, {
            headers: { 'x-apisports-key': API_KEY }
          }).then(r => r.json()),
        ]);
        enriched.push({
          fixture: fix.fixture,
          teams: fix.teams,
          score: fix.score,
          league: fix.league,
          statsHome: statsHome.response?.[0]?.statistics || [],
          statsAway: statsAway.response?.[0]?.statistics || [],
        });
      } catch(e) {
        enriched.push({ fixture: fix.fixture, teams: fix.teams, score: fix.score, league: fix.league, statsHome: [], statsAway: [] });
      }
    }
    res.json({ response: enriched, results: enriched.length });
  } catch (err) {
    res.status(500).json({ error: 'Error H2H', detail: err.message });
  }
});

// Proxy The Odds API
app.get('/odds/match', async (req, res) => {
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_API_KEY no configurada' });
  const { home, away, sport } = req.query;
  if (!home || !away) return res.status(400).json({ error: 'Se requieren home y away' });
  const sportKey = sport || 'soccer_epl';
  const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
  try {
    const response = await fetch(url);
    const games = await response.json();
    if (!Array.isArray(games)) return res.status(200).json({ found: false, games: [] });
    const homeLower = home.toLowerCase();
    const awayLower = away.toLowerCase();
    const match = games.find(g => {
      const ht = g.home_team.toLowerCase();
      const at = g.away_team.toLowerCase();
      return (ht.includes(homeLower) || homeLower.includes(ht.split(' ')[0])) &&
             (at.includes(awayLower) || awayLower.includes(at.split(' ')[0]));
    });
    if (!match) return res.json({ found: false, available_games: games.slice(0,5).map(g=>({home:g.home_team,away:g.away_team})) });
    const oddsResult = [];
    match.bookmakers.forEach(bm => {
      const h2h = bm.markets.find(m => m.key === 'h2h');
      if (!h2h) return;
      const homeOdds = h2h.outcomes.find(o => o.name === match.home_team)?.price;
      const awayOdds = h2h.outcomes.find(o => o.name === match.away_team)?.price;
      const drawOdds = h2h.outcomes.find(o => o.name === 'Draw')?.price;
      if (homeOdds && awayOdds) {
        oddsResult.push({
          bookmaker: bm.title, key: bm.key,
          home: parseFloat(homeOdds.toFixed(2)),
          draw: drawOdds ? parseFloat(drawOdds.toFixed(2)) : null,
          away: parseFloat(awayOdds.toFixed(2)),
        });
      }
    });
    res.json({ found: true, home_team: match.home_team, away_team: match.away_team, commence_time: match.commence_time, bookmakers: oddsResult });
  } catch (err) {
    res.status(500).json({ error: 'Error Odds API', detail: err.message });
  }
});

app.get('/odds/sports', async (req, res) => {
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) return res.status(500).json({ error: 'ODDS_API_KEY no configurada' });
  try {
    const r = await fetch(`${ODDS_API_BASE}/sports/?apiKey=${ODDS_KEY}`);
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => { console.log(`Proxy corriendo en puerto ${PORT}`); });
