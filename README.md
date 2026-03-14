# API-Football Proxy

Servidor proxy para eliminar errores CORS al usar API-Football desde el navegador.

## Deploy en Railway (gratis, 5 minutos)

### Paso 1 — Crear cuenta en Railway
Ve a **railway.app** y regístrate con tu cuenta de GitHub (es gratis).

### Paso 2 — Subir este proyecto a GitHub
1. Ve a **github.com** → New Repository
2. Nombre: `api-football-proxy`
3. Sube estos archivos: `index.js`, `package.json`, `railway.toml`, `.gitignore`

También puedes usar GitHub Desktop si prefieres interfaz gráfica.

### Paso 3 — Crear proyecto en Railway
1. En railway.app → **New Project**
2. Selecciona **Deploy from GitHub repo**
3. Elige `api-football-proxy`
4. Railway detecta automáticamente que es Node.js y hace el deploy

### Paso 4 — Configurar tu API Key (¡MUY IMPORTANTE!)
En Railway, dentro de tu proyecto:
1. Ve a la pestaña **Variables**
2. Haz clic en **New Variable**
3. Nombre: `API_FOOTBALL_KEY`
4. Valor: tu API key de api-football.com
5. Haz clic en **Add**

Railway reinicia el servidor automáticamente.

### Paso 5 — Obtener tu URL pública
1. Ve a la pestaña **Settings** → **Networking**
2. Haz clic en **Generate Domain**
3. Copia la URL generada (ej: `https://api-football-proxy-production.up.railway.app`)

### Paso 6 — Usar en la herramienta de apuestas
En la herramienta de Claude, pega esa URL en el campo **"URL de tu proxy"**.

## Probar que funciona
Abre en tu navegador:
```
https://TU-URL.up.railway.app/api/status
```
Deberías ver tu información de cuenta de API-Football.

## Endpoints disponibles
El proxy reenvía cualquier ruta de API-Football:
- `/api/status` → estado de tu cuenta
- `/api/teams?name=Barcelona` → buscar equipos
- `/api/fixtures?team=541&last=10` → últimos partidos
- `/api/fixtures/statistics?fixture=123` → estadísticas de partido
- `/api/fixtures/players?fixture=123&team=541` → estadísticas de jugadores

## Seguridad
- Tu API key **nunca** se expone al navegador
- Está guardada como variable de entorno en Railway
- El proxy solo reenvía peticiones a API-Football
