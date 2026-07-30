const express = require('express')
const session = require('express-session')
const path = require('path')
const fs = require('fs')

const configPath = path.join(__dirname, '..', 'data', 'config.json')
const CLIENT_ID = process.env.DISCORD_CLIENT_ID
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET
const PORT = process.env.WEB_PORT || 3001
const BASE = `http://${process.env.VPS_IP || 'localhost'}:${PORT}`

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return { guilds: {} } }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
}

const app = express()
app.use(session({ secret: process.env.SESSION_SECRET || 'change-me', resave: false, saveUninitialized: false }))
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, '..', 'views'))

function isAuthenticated(req, res, next) {
  if (req.session.user) return next()
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/auth/discord/callback')}&response_type=code&scope=identify`
  res.redirect(url)
}

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `${BASE}/auth/discord/callback`,
      }),
    })
    const tokenData = await tokenRes.json()
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to get token')
    }
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })
    const user = await userRes.json()
    req.session.user = { id: user.id, username: user.username, avatar: user.avatar, globalName: user.global_name }
    res.redirect('/')
  } catch (err) {
    console.error('OAuth error:', err)
    res.status(500).send('Authentication failed')
  }
})

app.get('/logout', (req, res) => {
  req.session.destroy()
  res.redirect('/login')
})

app.get('/', isAuthenticated, (req, res) => {
  const cfg = loadConfig()
  const guilds = Object.keys(cfg.guilds).map(id => {
    const guild = req.app.locals.client.guilds.cache.get(id)
    return { id, name: guild ? guild.name : id }
  })
  res.render('dashboard', { user: req.session.user, guilds, base: BASE })
})

app.post('/api/announce', isAuthenticated, async (req, res) => {
  try {
    const { guildId, title, description, color, image, thumbnail, footer, timestamp, fields } = req.body
    if (!guildId || !title || !description) {
      return res.status(400).send('Missing required fields: guildId, title, description')
    }
    const cfg = loadConfig()
    const channelId = cfg.guilds[guildId]?.channelId
    if (!channelId) {
      return res.status(400).send('No channel configured for this guild. Use /setchannel in Discord first.')
    }
    const embed = { title, description, color: parseInt(color?.replace('#', '') || '5865F2', 16), timestamp: timestamp ? new Date().toISOString() : undefined }
    if (image) embed.image = { url: image }
    if (thumbnail) embed.thumbnail = { url: thumbnail }
    if (footer) embed.footer = { text: footer }
    if (fields) {
      const parsed = Array.isArray(fields) ? fields : [fields]
      embed.fields = parsed.map(f => ({ name: f.name, value: f.value, inline: f.inline === 'true' || f.inline === true }))
    }
    const channel = await req.app.locals.client.channels.fetch(channelId)
    if (!channel) return res.status(400).send('Channel not found')
    await channel.send({ embeds: [embed] })
    res.send('Announcement sent!')
  } catch (err) {
    console.error('Announce error:', err)
    res.status(500).send('Failed to send: ' + err.message)
  }
})

module.exports = { app, PORT, start: (client) => {
  app.locals.client = client
  return new Promise(resolve => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Web server on http://0.0.0.0:${PORT}`)
      resolve()
    })
  })
}}
