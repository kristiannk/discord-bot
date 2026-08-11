const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice')
const { spawn, execSync } = require('child_process')
const path = require('path')
const play = require('play-dl')
const eco = require('./economy')
require('dotenv').config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

// Debug voice event forwarding
{
  const _origOnVS = client.voice.onVoiceServer.bind(client.voice)
  const _origOnVSU = client.voice.onVoiceStateUpdate.bind(client.voice)
  client.voice.onVoiceServer = function (payload) {
    console.log('VOICE_SERVER_UPDATE for guild', payload.guild_id, 'has adapter:', this.adapters.has(payload.guild_id))
    return _origOnVS(payload)
  }
  client.voice.onVoiceStateUpdate = function (payload) {
    if (payload.guild_id && payload.session_id && payload.user_id === this.client.user?.id) {
      console.log('VOICE_STATE_UPDATE for guild', payload.guild_id, 'has adapter:', this.adapters.has(payload.guild_id))
    }
    return _origOnVSU(payload)
  }
}

client.on('error', console.error)
process.on('unhandledRejection', console.error)

// Log ALL raw gateway voice packets
client.on('raw', packet => {
  if (packet.t === 'VOICE_SERVER_UPDATE' || packet.t === 'VOICE_STATE_UPDATE') {
    console.log('RAW', packet.t, JSON.stringify(packet.d))
  }
})

const ffmpegPath = require('ffmpeg-static')

const YT_API_KEY = process.env.YT_API_KEY
const cookiesPath = path.join(__dirname, '..', 'cookies.txt')

const runPyPath = path.join(__dirname, '..', 'run.py')
const ytDlpExe = (() => {
  if (process.platform !== 'win32') return null
  try { return execSync('where yt-dlp', { encoding: 'utf8' }).trim().split(/\r?\n/)[0] } catch { return null }
})()
const nodeDir = (() => {
  try { return path.dirname(execSync('where node', { encoding: 'utf8' }).trim().split(/\r?\n/)[0]) } catch { return null }
})()
const usePyWrapper = process.platform === 'win32' && require('fs').existsSync(runPyPath)
const ytDlpBin = usePyWrapper ? 'python' : 'yt-dlp'
const ytDlpArgs = usePyWrapper ? [runPyPath, ytDlpExe || 'yt-dlp'] : []
console.log('ytDlpBin:', ytDlpBin, 'ytDlpArgs:', ytDlpArgs)
console.log('nodeDir:', nodeDir)

const queue = new Map()
const activeProcesses = new Map()

const ytDlpEnv = { ...process.env }
if (nodeDir) {
  const pathKey = Object.keys(ytDlpEnv).find(k => k.toLowerCase() === 'path') || 'Path'
  ytDlpEnv[pathKey] = nodeDir + ';' + (ytDlpEnv[pathKey] || '')
}

function getQueue(guildId) {
  if (!queue.has(guildId)) {
    queue.set(guildId, { songs: [], player: null, connection: null, playing: false, volume: 1.0, currentResource: null })
  }
  return queue.get(guildId)
}

async function getYtInfo(url) {
  const args = ['--extractor-args', 'youtube:player_client=mweb', '--print-json', '--no-warnings']
  if (require('fs').existsSync(cookiesPath)) args.push('--cookies', cookiesPath)
  const spawnOpts = { env: ytDlpEnv }
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, [...ytDlpArgs, ...args, url], spawnOpts)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp failed: ${stderr}`))
      try {
        resolve(JSON.parse(stdout))
      } catch { reject(new Error('Failed to parse yt-dlp output')) }
    })
    proc.on('error', reject)
  })
}

async function searchYoutube(query) {
  if (!YT_API_KEY) {
    const results = await play.search(query, { limit: 1 })
    if (!results.length) return null
    return { title: results[0].title, url: results[0].url }
  }
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YT_API_KEY}&maxResults=1&type=video`)
  const data = await res.json()
  if (!data.items?.length) return null
  const video = data.items[0]
  return { title: video.snippet.title, url: `https://youtu.be/${video.id.videoId}` }
}

async function playSong(guildId, retries = 3) {
  const q = getQueue(guildId)
  if (!q.songs.length || !q.connection) {
    q.playing = false
    return
  }

  q.playing = true
  const song = q.songs[0]

  try {
    if (q.connection.state.status !== VoiceConnectionStatus.Ready) {
      try {
        await entersState(q.connection, VoiceConnectionStatus.Ready, 20_000)
      } catch {
        if (retries > 0 && q.connection.state.status !== 'destroyed') {
          console.log('Retrying voice connection...')
          try {
            await entersState(q.connection, VoiceConnectionStatus.Signalling, 5_000)
          } catch {}
          q.connection.rejoin({ channelId: q.connection.joinConfig.channelId })
          return playSong(guildId, retries - 1)
        }
        throw new Error('Voice not ready after retries')
      }
    }

    const os = require('os')
    const fs = require('fs')
    const tmpFile = path.join(os.tmpdir(), `ytdlp-${guildId}-${Date.now()}.mp4`)

    const dlArgs = ['-f', '18', '-o', tmpFile, '--extractor-args', 'youtube:player_client=mweb', '--cookies', cookiesPath, '--no-warnings']
    console.log('Downloading to temp file:', tmpFile)
    const ytdlp = spawn(ytDlpBin, [...ytDlpArgs, ...dlArgs, song.url], { env: ytDlpEnv })

    activeProcesses.set(guildId, ytdlp)

    ytdlp.stderr.on('data', (d) => {
      const msg = d.toString()
      console.log('yt-dlp stderr:', msg.trim())
    })

    ytdlp.on('error', (err) => {
      console.error('yt-dlp spawn error:', err.message)
      q.songs.shift()
      playSong(guildId)
    })

    ytdlp.on('close', code => {
      console.log('yt-dlp closed with code:', code)
      if (code !== 0 && code !== null) {
        console.error(`yt-dlp exited with code ${code}`)
        try { fs.unlinkSync(tmpFile) } catch {}
        q.songs.shift()
        playSong(guildId)
        return
      }

      let fileSize = 0
      try {
        const stat = fs.statSync(tmpFile)
        fileSize = stat.size
      } catch (e) { console.error('stat error:', e.message) }
      console.log('Download complete, file size:', fileSize, 'bytes')

      if (fileSize === 0) {
        console.error('File is empty!')
        q.songs.shift()
        playSong(guildId)
        return
      }

      console.log('Starting ffmpeg from file:', tmpFile)
      const ffmpeg = spawn(ffmpegPath, [
        '-i', tmpFile,
        '-af', 'aresample=48000',
        '-f', 'opus',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1',
      ])

      ffmpeg.stderr.on('data', (d) => {
        console.log('ffmpeg stderr:', d.toString().trim())
      })
      ffmpeg.on('error', (err) => console.error('FFmpeg error:', err.message))
      ffmpeg.on('close', (code) => {
        console.log('ffmpeg closed with code:', code)
        try { fs.unlinkSync(tmpFile) } catch {}
      })

      const resource = createAudioResource(ffmpeg.stdout, { inputType: 'ogg/opus', inlineVolume: true })
      resource.volume.setVolume(q.volume)
      q.currentResource = resource
      q.player.play(resource)
      q.player.on('error', (err) => console.error('Player error:', err.message))
      q.player.on('stateChange', (oldS, newS) => console.log('Player state:', oldS.status, '->', newS.status))

    })
  } catch (err) {
    console.error('Error playing song:', err)
    q.songs.shift()
    playSong(guildId)
  }
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Tes bot: ping'),
  new SlashCommandBuilder().setName('uptime').setDescription('Menampilkan uptime bot'),
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Putar lagu dari YouTube (link atau judul)')
    .addStringOption(opt => opt.setName('query').setDescription('Link YouTube atau judul lagu').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip lagu yang sedang diputar'),
  new SlashCommandBuilder().setName('stop').setDescription('Berhenti dan keluar dari voice channel'),
  new SlashCommandBuilder().setName('queue').setDescription('Lihat antrian lagu'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Lagu yang sedang diputar'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Atur volume lagu yang sedang diputar (0-200%)')
    .addIntegerOption(opt => opt.setName('percent').setDescription('Volume dalam persen (0-200)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set channel untuk announcement')
    .addChannelOption(opt => opt.setName('channel').setDescription('Pilih channel').setRequired(true)),
  new SlashCommandBuilder()
    .setName('seteventchannel')
    .setDescription('Set channel untuk pengumuman tanggal (event/rapat)')
    .addChannelOption(opt => opt.setName('channel').setDescription('Pilih channel').setRequired(true)),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Beri warning ke member yang melakukan kesalahan')
    .addUserOption(opt => opt.setName('user').setDescription('Member yang di-warn').setRequired(true))
    .addStringOption(opt => opt.setName('reason').setDescription('Alasan / kesalahan yang dilakukan').setRequired(true)),
  new SlashCommandBuilder()
    .setName('warns')
    .setDescription('Lihat total warning seorang member')
    .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Hapus warning terakhir dari seorang member')
    .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clearwarns')
    .setDescription('Reset semua warning seorang member')
    .addUserOption(opt => opt.setName('user').setDescription('Member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setwarnrole')
    .setDescription('Set role yang diberikan ke member yang di-warn')
    .addRoleOption(opt => opt.setName('role').setDescription('Pilih role').setRequired(true)),
  new SlashCommandBuilder()
    .setName('setwarnchannel')
    .setDescription('Set channel untuk embed pesan warning')
    .addChannelOption(opt => opt.setName('channel').setDescription('Pilih channel').setRequired(true)),
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Cek saldo coin kamu atau member lain')
    .addUserOption(opt => opt.setName('user').setDescription('Member (opsional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Klaim coin harian gratis'),
  new SlashCommandBuilder()
    .setName('give')
    .setDescription('Transfer coin ke member lain')
    .addUserOption(opt => opt.setName('user').setDescription('Member tujuan').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah coin').setRequired(true)),
  new SlashCommandBuilder()
    .setName('slots')
    .setDescription('Main slot machine, menang hingga 10x lipat')
    .addIntegerOption(opt => opt.setName('bet').setDescription('Jumlah taruhan').setRequired(true)),
  new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Tebak koin, peluang 50/50')
    .addStringOption(opt => opt.setName('choice').setDescription('heads atau tails').setRequired(true).addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }))
    .addIntegerOption(opt => opt.setName('bet').setDescription('Jumlah taruhan').setRequired(true)),
  new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Main blackjack melawan dealer')
    .addIntegerOption(opt => opt.setName('bet').setDescription('Jumlah taruhan').setRequired(true)),
  new SlashCommandBuilder()
    .setName('hunt')
    .setDescription('Berburu hewan untuk koleksi zoo-mu'),
  new SlashCommandBuilder()
    .setName('zoo')
    .setDescription('Lihat koleksi hewan zoo')
    .addUserOption(opt => opt.setName('user').setDescription('Member (opsional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Jual hewan dari zoo (nama, rarity, atau all)')
    .addStringOption(opt => opt.setName('target').setDescription('Nama hewan / rarity / all').setRequired(true)),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Lihat level dan XP-mu')
    .addUserOption(opt => opt.setName('user').setDescription('Member (opsional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Top leaderboard (balance / zoo / level)')
    .addStringOption(opt => opt.setName('type').setDescription('Jenis leaderboard').setRequired(true).addChoices({ name: 'Balance', value: 'balance' }, { name: 'Zoo', value: 'zoo' }, { name: 'Level', value: 'level' })),
].map(cmd => cmd.toJSON())

const fs_cmd = require('fs')
const configPath = require('path').join(__dirname, '..', 'data', 'config.json')
function loadConfig() {
  try { return JSON.parse(fs_cmd.readFileSync(configPath, 'utf8')) } catch { return { guilds: {} } }
}
function saveConfig(cfg) {
  require('fs').mkdirSync(require('path').dirname(configPath), { recursive: true })
  require('fs').writeFileSync(configPath, JSON.stringify(cfg, null, 2))
}

async function getWarnRole(guild) {
  const cfg = loadConfig()
  const gid = guild.id
  if (cfg.guilds[gid]?.warnRoleId) {
    const role = guild.roles.cache.get(cfg.guilds[gid].warnRoleId)
    if (role) return role
  }
  let role = guild.roles.cache.find(r => r.name === 'Warned')
  if (!role) {
    role = await guild.roles.create({ name: 'Warned', color: 0xffa500, reason: 'Auto-created for warn system' })
  }
  if (!cfg.guilds[gid]) cfg.guilds[gid] = {}
  cfg.guilds[gid].warnRoleId = role.id
  saveConfig(cfg)
  return role
}

async function removeWarnRole(guild, userId) {
  const cfg = loadConfig()
  const roleId = cfg.guilds[guild.id]?.warnRoleId
  if (!roleId) return
  try {
    const member = await guild.members.fetch(userId)
    if (member.roles.cache.has(roleId)) await member.roles.remove(roleId)
  } catch {}
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return

  const { commandName, guildId, member } = interaction

  if (commandName === 'ping') {
    return interaction.reply({ content: 'Pong!', ephemeral: true })
  }

  if (commandName === 'uptime') {
    const ms = client.uptime ?? 0
    const sec = Math.floor(ms / 1000)
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return interaction.reply({ content: `Uptime: ${h}h ${m}m ${s}s`, ephemeral: true })
  }

  if (commandName === 'play') {
    await interaction.deferReply()
    const voiceChannel = member.voice.channel
    if (!voiceChannel) {
      return interaction.editReply('Kamu harus join voice channel dulu!')
    }

    const q = getQueue(guildId)

    if (!q.connection) {
      const targetChannel = interaction.guild.channels.cache.get('1424393815132868743') || voiceChannel

      const _guild = interaction.guild
      const origCreator = _guild.voiceAdapterCreator
      const wrapped = methods => {
        console.log('ADAPTER CREATED for guild', _guild.id)
        const r = origCreator(methods)
        const origSend = r.sendPayload
        r.sendPayload = data => {
          const ok = origSend(data)
          console.log('sendPayload:', ok, 'shard status:', _guild.shard?.status)
          return ok
        }
        return r
      }

      q.connection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId,
        adapterCreator: wrapped,
        debug: true,
      })
      q.player = createAudioPlayer()

      q.connection.on('stateChange', (oldState, newState) => {
        console.log(`Voice: ${oldState.status} -> ${newState.status}`)
        if (newState.status === 'disconnected') {
          console.log('  reason:', newState.reason, 'closeCode:', newState.closeCode)
        }
        if (newState.status === 'signalling' && oldState.status === 'connecting') {
          console.log('  networking closed, rejoin attempt:', q.connection.rejoinAttempts)
        }
      })
      q.connection.on('error', err => console.error('Voice connection error:', err))
      q.connection.on('debug', msg => console.log('Voice debug:', msg))
      q.player.on(AudioPlayerStatus.Idle, () => {
        const proc = activeProcesses.get(guildId)
        if (proc) { proc.kill(); activeProcesses.delete(guildId) }
        q.currentResource = null
        q.songs.shift()
        playSong(guildId)
      })
      q.player.on('error', error => {
        console.error('Player error:', error)
        const proc = activeProcesses.get(guildId)
        if (proc) { proc.kill(); activeProcesses.delete(guildId) }
        q.currentResource = null
        q.songs.shift()
        playSong(guildId)
      })
    }

    const query = interaction.options.getString('query', true)

    let songUrl

    if (play.yt_validate(query) === 'video') {
      songUrl = query
    } else {
      const result = await searchYoutube(query)
      if (!result) return interaction.editReply('Lagu tidak ditemukan!')
      songUrl = result.url
    }

    try {
      const [info] = await Promise.all([
        getYtInfo(songUrl),
        entersState(q.connection, VoiceConnectionStatus.Ready, 30_000),
      ])

      q.connection.subscribe(q.player)

      const songInfo = {
        title: info.title,
        url: songUrl,
        thumbnail: info.thumbnail,
        duration: formatDuration(info.duration),
        requestedBy: member.user.tag,
      }

      q.songs.push(songInfo)
      if (!q.playing) playSong(guildId)

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('Ditambahkan ke antrian')
        .setDescription(`[${songInfo.title}](${songInfo.url})`)
        .setThumbnail(songInfo.thumbnail)
        .addFields(
          { name: 'Durasi', value: songInfo.duration, inline: true },
          { name: 'Antrian', value: `${q.songs.length} lagu`, inline: true },
          { name: 'Diminta oleh', value: songInfo.requestedBy, inline: true },
        )

      return interaction.editReply({ embeds: [embed] })
    } catch (err) {
      console.error('Play error:', err?.message || err)
      q.connection?.destroy()
      q.connection = null
      return interaction.editReply('Gagal memproses lagu: ' + (err?.message || err))
    }
  }

  if (commandName === 'skip') {
    const q = getQueue(guildId)
    if (!q.playing || !q.player) {
      return interaction.reply({ content: 'Tidak ada lagu yang diputar.', ephemeral: true })
    }
    q.player.stop()
    return interaction.reply({ content: '⏭ Lagu di-skip!' })
  }

  if (commandName === 'stop') {
    const q = getQueue(guildId)
    if (!q.connection) {
      return interaction.reply({ content: 'Bot tidak sedang di voice channel.', ephemeral: true })
    }
    const proc = activeProcesses.get(guildId)
    if (proc) { proc.kill(); activeProcesses.delete(guildId) }
    q.songs = []
    q.playing = false
    if (q.player) q.player.stop()
    q.connection.destroy()
    q.connection = null
    return interaction.reply({ content: '⏹ Berhenti dan keluar dari voice channel.' })
  }

  if (commandName === 'queue') {
    const q = getQueue(guildId)
    if (!q.songs.length) {
      return interaction.reply({ content: 'Antrian kosong.', ephemeral: true })
    }

    const list = q.songs.map((s, i) => {
      const now = i === 0 ? '▶ **Sekarang**: ' : `${i + 1}. `
      return `${now}[${s.title}](${s.url}) — ${s.duration} (diminta oleh ${s.requestedBy})`
    }).join('\n')

    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(`Antrian Lagu (${q.songs.length})`)
      .setDescription(list)

    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'nowplaying') {
    const q = getQueue(guildId)
    if (!q.playing || !q.songs.length) {
      return interaction.reply({ content: 'Tidak ada lagu yang sedang diputar.', ephemeral: true })
    }

    const song = q.songs[0]
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle('Sedang Diputar')
      .setDescription(`[${song.title}](${song.url})`)
      .setThumbnail(song.thumbnail)
      .addFields(
        { name: 'Durasi', value: song.duration, inline: true },
        { name: 'Diminta oleh', value: song.requestedBy, inline: true },
      )

    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'volume') {
    const q = getQueue(guildId)
    const percent = interaction.options.getInteger('percent')
    if (!q.playing || !q.songs.length) {
      return interaction.reply({ content: 'Tidak ada lagu yang diputar.', ephemeral: true })
    }
    if (percent === null) {
      return interaction.reply({ content: `🔊 Volume sekarang: **${Math.round(q.volume * 100)}%**` })
    }
    if (percent < 0 || percent > 200) {
      return interaction.reply({ content: 'Volume harus antara **0 - 200%**.', ephemeral: true })
    }
    q.volume = percent / 100
    if (q.currentResource?.volume) {
      q.currentResource.volume.setVolume(q.volume)
    }
    return interaction.reply({ content: `🔊 Volume diset ke **${percent}%**` })
  }

  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel')
    const cfg = loadConfig()
    if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {}
    cfg.guilds[guildId].channelId = channel.id
    saveConfig(cfg)
    return interaction.reply({ content: `Channel announcement diset ke <#${channel.id}>`, ephemeral: true })
  }

  if (commandName === 'seteventchannel') {
    const channel = interaction.options.getChannel('channel')
    const cfg = loadConfig()
    if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {}
    cfg.guilds[guildId].eventChannelId = channel.id
    saveConfig(cfg)
    return interaction.reply({ content: `Channel pengumuman tanggal diset ke <#${channel.id}>`, ephemeral: true })
  }

  const canWarn = () => ['ManageMessages', 'KickMembers', 'ModerateMembers'].some(p => member.permissions.has(p))

  if (commandName === 'setwarnrole') {
    if (!canWarn()) {
      return interaction.reply({ content: 'Kamu butuh permission Manage Messages / Kick Members untuk menggunakan ini.', ephemeral: true })
    }
    const role = interaction.options.getRole('role')
    const cfg = loadConfig()
    if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {}
    cfg.guilds[guildId].warnRoleId = role.id
    saveConfig(cfg)
    return interaction.reply({ content: `Role warning diset ke <@&${role.id}>`, ephemeral: true })
  }

  if (commandName === 'setwarnchannel') {
    if (!canWarn()) {
      return interaction.reply({ content: 'Kamu butuh permission Manage Messages / Kick Members untuk menggunakan ini.', ephemeral: true })
    }
    const channel = interaction.options.getChannel('channel')
    const cfg = loadConfig()
    if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {}
    cfg.guilds[guildId].warnChannelId = channel.id
    saveConfig(cfg)
    return interaction.reply({ content: `Channel pesan warning diset ke <#${channel.id}>`, ephemeral: true })
  }

  if (commandName === 'warn') {
    if (!canWarn()) {
      return interaction.reply({ content: 'Kamu butuh permission Manage Messages / Kick Members untuk menggunakan ini.', ephemeral: true })
    }
    const target = interaction.options.getUser('user')
    const reason = interaction.options.getString('reason', true)
    const cfg = loadConfig()
    if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {}
    if (!cfg.guilds[guildId].warnings) cfg.guilds[guildId].warnings = {}
    if (!cfg.guilds[guildId].warnings[target.id]) cfg.guilds[guildId].warnings[target.id] = []
    cfg.guilds[guildId].warnings[target.id].push({ reason, at: new Date().toISOString(), by: member.user.tag })
    saveConfig(cfg)
    const total = cfg.guilds[guildId].warnings[target.id].length

    try {
      const role = await getWarnRole(interaction.guild)
      const targetMember = await interaction.guild.members.fetch(target.id)
      if (!targetMember.roles.cache.has(role.id)) await targetMember.roles.add(role)
    } catch (err) {
      console.error('Warn role error:', err?.message || err)
    }

    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle('⚠️ Warning Diberikan')
      .setDescription(`${target} telah di-warning`)
      .addFields(
        { name: 'Alasan', value: reason },
        { name: 'Total Warning', value: String(total), inline: true },
        { name: 'Oleh', value: member.user.tag, inline: true },
      )

    const warnChannelId = cfg.guilds[guildId].warnChannelId
    if (warnChannelId) {
      try {
        const warnChannel = await interaction.guild.channels.fetch(warnChannelId)
        await warnChannel.send({ embeds: [embed] })
        return interaction.reply({ content: `⚠️ Warning diberikan ke ${target} (Total: **${total}**). Embed dikirim ke <#${warnChannelId}>.`, ephemeral: true })
      } catch (err) {
        console.error('Warn channel error:', err?.message || err)
      }
    }
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'warns') {
    const target = interaction.options.getUser('user')
    const cfg = loadConfig()
    const warns = cfg.guilds[guildId]?.warnings?.[target.id] || []
    if (!warns.length) {
      return interaction.reply({ content: `${target} tidak punya warning. ✅`, ephemeral: true })
    }
    const list = warns.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(new Date(w.at).getTime() / 1000)}:R> (oleh ${w.by})`).join('\n')
    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle(`⚠️ Warning ${target.tag}`)
      .setDescription(`Total: **${warns.length}** warning`)
      .addFields({ name: 'Riwayat', value: list })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'unwarn') {
    if (!canWarn()) {
      return interaction.reply({ content: 'Kamu butuh permission Manage Messages / Kick Members untuk menggunakan ini.', ephemeral: true })
    }
    const target = interaction.options.getUser('user')
    const cfg = loadConfig()
    const warns = cfg.guilds[guildId]?.warnings?.[target.id]
    if (!warns || !warns.length) {
      return interaction.reply({ content: `${target} tidak punya warning.`, ephemeral: true })
    }
    const removed = warns.pop()
    saveConfig(cfg)
    if (!warns.length) await removeWarnRole(interaction.guild, target.id)
    return interaction.reply({ content: `✅ Warning terakhir ${target} dihapus (${removed.reason}). Sisa: **${warns.length}** warning.` })
  }

  if (commandName === 'clearwarns') {
    if (!canWarn()) {
      return interaction.reply({ content: 'Kamu butuh permission Manage Messages / Kick Members untuk menggunakan ini.', ephemeral: true })
    }
    const target = interaction.options.getUser('user')
    const cfg = loadConfig()
    if (cfg.guilds[guildId]?.warnings) {
      delete cfg.guilds[guildId].warnings[target.id]
      saveConfig(cfg)
    }
    await removeWarnRole(interaction.guild, target.id)
    return interaction.reply({ content: `✅ Semua warning ${target} direset.` })
  }

  if (commandName === 'balance') {
    const target = interaction.options.getUser('user') || member.user
    const db = eco.load()
    const u = eco.getUser(db, guildId, target.id)
    const info = eco.getLevelInfo(u.xp)
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`Saldo ${target.username}`)
      .addFields(
        { name: `${eco.COIN} Balance`, value: eco.formatNumber(u.balance), inline: true },
        { name: '⭐ Level', value: `${info.level} (${eco.formatNumber(u.xp)} XP)`, inline: true },
        { name: '🦊 Zoo', value: `${u.zoo.length} hewan`, inline: true },
      )
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'daily') {
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    const now = Date.now()
    const last = u.lastDaily ? new Date(u.lastDaily).getTime() : 0
    const elapsed = now - last
    const DAY = 24 * 60 * 60 * 1000
    if (elapsed < DAY) {
      const waitMs = DAY - elapsed
      const h = Math.floor(waitMs / 3600000)
      const m = Math.floor((waitMs % 3600000) / 60000)
      return interaction.reply({ content: `⏳ Kamu sudah klaim hari ini. Klaim lagi dalam **${h}j ${m}m**.`, ephemeral: true })
    }
    const reward = 100
    u.balance += reward
    u.lastDaily = new Date().toISOString()
    eco.save(db)
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💰 Daily Reward')
      .setDescription(`Kamu dapat **${eco.formatNumber(reward)}** ${eco.COIN}!`)
      .setFooter({ text: `Saldo sekarang: ${eco.formatNumber(u.balance)} ${eco.COIN}` })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'give') {
    const target = interaction.options.getUser('user')
    const amount = interaction.options.getInteger('amount', true)
    if (amount <= 0) return interaction.reply({ content: 'Jumlah harus lebih dari 0.', ephemeral: true })
    const db = eco.load()
    const from = eco.getUser(db, guildId, member.user.id)
    const to = eco.getUser(db, guildId, target.id)
    if (from.balance < amount) {
      return interaction.reply({ content: `Saldo kamu tidak cukup. (${eco.formatNumber(from.balance)} ${eco.COIN})`, ephemeral: true })
    }
    from.balance -= amount
    to.balance += amount
    eco.save(db)
    return interaction.reply({ content: `${eco.COIN} ${eco.formatNumber(amount)} coin diberikan ke ${target}. Saldo kamu: **${eco.formatNumber(from.balance)}** ${eco.COIN}` })
  }

  if (commandName === 'slots') {
    const bet = interaction.options.getInteger('bet', true)
    if (bet <= 0) return interaction.reply({ content: 'Taruhan harus lebih dari 0.', ephemeral: true })
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    if (u.balance < bet) return interaction.reply({ content: `Saldo kamu tidak cukup. (${eco.formatNumber(u.balance)} ${eco.COIN})`, ephemeral: true })

    const symbols = ['🍒', '🍋', '🍇', '💎', '7️⃣', '⭐']
    const reel = () => symbols[Math.floor(Math.random() * symbols.length)]
    const a = reel(), b = reel(), c = reel()
    const line = `[ ${a} ${b} ${c} ]`
    let win = 0
    if (a === b && b === c) {
      const idx = symbols.indexOf(a)
      const mult = [3, 4, 5, 8, 10, 6][idx]
      win = bet * mult
    } else if (a === b || b === c || a === c) {
      win = Math.floor(bet * 1.5)
    }
    u.balance += win - bet
    eco.save(db)
    const embed = new EmbedBuilder()
      .setColor(win > 0 ? 0x57f287 : 0xed4245)
      .setTitle('🎰 Slot Machine')
      .setDescription(`${line}\n\n${win > 0 ? `🎉 Kamu menang **${eco.formatNumber(win)}** ${eco.COIN}!` : `💔 Kamu kalah **${eco.formatNumber(bet)}** ${eco.COIN}.`}`)
      .setFooter({ text: `Saldo: ${eco.formatNumber(u.balance)} ${eco.COIN}` })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'coinflip') {
    const choice = interaction.options.getString('choice', true)
    const bet = interaction.options.getInteger('bet', true)
    if (bet <= 0) return interaction.reply({ content: 'Taruhan harus lebih dari 0.', ephemeral: true })
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    if (u.balance < bet) return interaction.reply({ content: `Saldo kamu tidak cukup. (${eco.formatNumber(u.balance)} ${eco.COIN})`, ephemeral: true })

    const result = Math.random() < 0.5 ? 'heads' : 'tails'
    const win = choice === result
    u.balance += win ? bet : -bet
    eco.save(db)
    const embed = new EmbedBuilder()
      .setColor(win ? 0x57f287 : 0xed4245)
      .setTitle('🪙 Coin Flip')
      .setDescription(`${result === 'heads' ? 'Heads' : 'Tails'}!\n\n${win ? `🎉 Kamu menang **${eco.formatNumber(bet)}** ${eco.COIN}!` : `💔 Kamu kalah **${eco.formatNumber(bet)}** ${eco.COIN}.`}`)
      .setFooter({ text: `Saldo: ${eco.formatNumber(u.balance)} ${eco.COIN}` })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'blackjack') {
    const bet = interaction.options.getInteger('bet', true)
    if (bet <= 0) return interaction.reply({ content: 'Taruhan harus lebih dari 0.', ephemeral: true })
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    if (u.balance < bet) return interaction.reply({ content: `Saldo kamu tidak cukup. (${eco.formatNumber(u.balance)} ${eco.COIN})`, ephemeral: true })
    u.balance -= bet
    eco.save(db)

    const drawCard = () => {
      const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
      return values[Math.floor(Math.random() * values.length)]
    }
    const cardValue = c => c === 'A' ? 11 : ['J', 'Q', 'K'].includes(c) ? 10 : parseInt(c, 10)
    const handValue = hand => {
      let sum = hand.reduce((s, c) => s + cardValue(c), 0)
      let aces = hand.filter(c => c === 'A').length
      while (sum > 21 && aces > 0) { sum -= 10; aces-- }
      return sum
    }
    const display = hand => hand.map(c => `\`${c}\``).join(' ')

    const playerHand = [drawCard(), drawCard()]
    const dealerHand = [drawCard(), drawCard()]

    const makeEmbed = (pVal, dVal, status, ended) => new EmbedBuilder()
      .setColor(status === 'win' ? 0x57f287 : status === 'lose' ? 0xed4245 : 0x5865f2)
      .setTitle('🃏 Blackjack')
      .setDescription(`**Taruhan:** ${eco.formatNumber(bet)} ${eco.COIN}\n**Dealer:** ${display(dealerHand)} ${ended ? `= **${dVal}**` : `(??)`}\n**Kamu:** ${display(playerHand)} = **${pVal}**\n\n${status}`)
      .setFooter({ text: ended ? `Saldo: ${eco.formatNumber(u.balance)} ${eco.COIN}` : 'Pilih aksi di bawah!' })

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId('bj_hit').setLabel('Hit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bj_stand').setLabel('Stand').setStyle(ButtonStyle.Danger),
      )

    const finish = async (i, msg) => {
      const pVal = handValue(playerHand)
      const dVal = handValue(dealerHand)
      let status
      if (pVal > 21) status = '💔 Bust! Kamu kalah.'
      else if (dVal > 21) { u.balance += bet * 2; status = '🎉 Dealer bust! Kamu menang 2x lipat!' }
      else if (pVal > dVal) { u.balance += bet * 2; status = '🎉 Kamu menang 2x lipat!' }
      else if (pVal === dVal) { u.balance += bet; status = '🤝 Push! Taruhan kembali.' }
      else status = '💔 Dealer menang. Kamu kalah.'
      eco.save(db)
      await i.update({ embeds: [makeEmbed(pVal, dVal, status, true)], components: [] })
      collector.stop()
    }

    await interaction.reply({ embeds: [makeEmbed(handValue(playerHand), handValue(dealerHand), 'Giliran kamu!', false)], components: [row] })

    const filter = i => i.user.id === member.user.id
    const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 })
    collector.on('collect', async i => {
      if (i.customId === 'bj_hit') {
        playerHand.push(drawCard())
        if (handValue(playerHand) >= 21) return finish(i)
        await i.update({ embeds: [makeEmbed(handValue(playerHand), handValue(dealerHand), 'Giliran kamu!', false)], components: [row] })
      } else if (i.customId === 'bj_stand') {
        while (handValue(dealerHand) < 17) dealerHand.push(drawCard())
        return finish(i)
      }
    })
    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        u.balance += bet
        eco.save(db)
        await interaction.editReply({ content: '⏰ Waktu habis, taruhan dikembalikan.', embeds: [makeEmbed(handValue(playerHand), handValue(dealerHand), 'Dibatalkan.', true)], components: [] }).catch(() => {})
      }
    })
  }

  if (commandName === 'hunt') {
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    const animal = eco.randomAnimal()
    u.zoo.push(animal)
    eco.save(db)
    const score = eco.zooScore(u.zoo)
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🏹 Berburu!')
      .setDescription(`Kamu berhasil menangkap **${eco.animalLabel(animal)}**!\nNilai: ${eco.formatNumber(animal.value)} ${eco.COIN}`)
      .setFooter({ text: `Zoo: ${u.zoo.length} hewan | Skor: ${eco.formatNumber(score)}` })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'zoo') {
    const target = interaction.options.getUser('user') || member.user
    const db = eco.load()
    const u = eco.getUser(db, guildId, target.id)
    const score = eco.zooScore(u.zoo)
    if (!u.zoo.length) {
      return interaction.reply({ content: `${target.username} belum punya hewan. Gunakan \`/hunt\` untuk mulai berburu!`, ephemeral: true })
    }
    const grouped = {}
    u.zoo.forEach(a => {
      if (!grouped[a.rarity]) grouped[a.rarity] = []
      grouped[a.rarity].push(a)
    })
    const desc = ['legendary', 'epic', 'rare', 'uncommon', 'common']
      .filter(r => grouped[r])
      .map(r => `${eco.RARITY_EMOJI[r]} **${eco.RARITY_LABEL[r]}** (${grouped[r].length}): ${grouped[r].slice(0, 10).map(a => a.name).join(', ')}${grouped[r].length > 10 ? '...' : ''}`)
      .join('\n')
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle(`🦁 Zoo ${target.username}`)
      .setDescription(desc)
      .setFooter({ text: `Total: ${u.zoo.length} hewan | Skor: ${eco.formatNumber(score)}` })
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'sell') {
    const target = interaction.options.getString('target', true).toLowerCase()
    const db = eco.load()
    const u = eco.getUser(db, guildId, member.user.id)
    if (!u.zoo.length) return interaction.reply({ content: 'Zoo kamu kosong.', ephemeral: true })

    const sellable = a => {
      if (target === 'all') return true
      if (eco.RARITIES.includes(target)) return a.rarity === target
      return a.name.toLowerCase() === target
    }
    const toSell = u.zoo.filter(sellable)
    if (!toSell.length) {
      return interaction.reply({ content: `Tidak ada hewan yang cocok dengan "${target}". Coba: nama hewan, rarity, atau "all".`, ephemeral: true })
    }
    const value = eco.zooScore(toSell)
    u.zoo = u.zoo.filter(a => !sellable(a))
    u.balance += value
    eco.save(db)
    const label = target === 'all' ? `${toSell.length} hewan` : toSell.map(a => a.name).join(', ')
    return interaction.reply({ content: `${eco.COIN} Menjual **${label}** seharga **${eco.formatNumber(value)}** ${eco.COIN}. Saldo: **${eco.formatNumber(u.balance)}** ${eco.COIN}` })
  }

  if (commandName === 'rank') {
    const target = interaction.options.getUser('user') || member.user
    const db = eco.load()
    const u = eco.getUser(db, guildId, target.id)
    const info = eco.getLevelInfo(u.xp)
    const pct = Math.floor((info.current / info.need) * 100)
    const barLen = 12
    const filled = Math.floor((pct / 100) * barLen)
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`⭐ ${target.username}`)
      .setDescription(`Level **${info.level}**\n\`${bar}\` ${pct}%\n\n${eco.formatNumber(info.current)} / ${eco.formatNumber(info.need)} XP menuju level ${info.level + 1}`)
    return interaction.reply({ embeds: [embed] })
  }

  if (commandName === 'leaderboard') {
    const type = interaction.options.getString('type', true)
    const db = eco.load()
    const entries = []
    for (const [k, u] of Object.entries(db.users)) {
      if (!k.startsWith(guildId + ':')) continue
      const userId = k.split(':')[1]
      if (type === 'balance') entries.push({ userId, value: u.balance })
      else if (type === 'zoo') entries.push({ userId, value: eco.zooScore(u.zoo) })
      else entries.push({ userId, value: u.xp, extra: eco.getLevelInfo(u.xp).level })
    }
    entries.sort((a, b) => b.value - a.value)
    if (!entries.length) return interaction.reply({ content: 'Belum ada data.', ephemeral: true })
    const top = entries.slice(0, 10)
    const medals = ['🥇', '🥈', '🥉']
    const lines = top.map((e, i) => {
      const name = client.users.cache.get(e.userId)?.username || e.userId
      const valueText = type === 'level' ? `Level ${e.extra} (${eco.formatNumber(e.value)} XP)` : `${eco.formatNumber(e.value)} ${type === 'zoo' ? 'skor' : '🪙'}`
      return `${medals[i] || `${i + 1}.`} **${name}** — ${valueText}`
    })
    const titles = { balance: '💰 Top Balance', zoo: '🦁 Top Zoo', level: '⭐ Top Level' }
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(titles[type])
      .setDescription(lines.join('\n'))
    return interaction.reply({ embeds: [embed] })
  }
})

client.on('messageCreate', message => {
  if (message.author.bot || !message.guild) return
  const db = eco.load()
  const u = eco.getUser(db, message.guild.id, message.author.id)
  const now = Date.now()
  if (now - (u.lastXp || 0) < 60000) return
  const before = eco.getLevelInfo(u.xp).level
  u.xp += Math.floor(Math.random() * 10) + 5
  u.lastXp = now
  eco.save(db)
  const after = eco.getLevelInfo(u.xp).level
  if (after > before) {
    message.channel.send(`🎉 ${message.author} naik ke level **${after}**!`)
  }
})

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN
  if (!token) throw new Error('Missing DISCORD_TOKEN in .env')

  const rest = new REST({ version: '10' }).setToken(token)
  if (!client.user?.id) {
    throw new Error('Client user is not ready')
  }

  const appId = client.user.id

  await rest.put(Routes.applicationCommands(appId), { body: commands })

  const guilds = client.guilds.cache
  for (const [guildId] of guilds) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] }).catch(() => {})
  }

  console.log('Slash command siap')
}

client.once('clientReady', async () => {
  try {
    await registerCommands()
  } catch (e) {
    console.error('Gagal register slash command:', e)
  }
  const { start: startWeb } = require('./web')
  startWeb(client).catch(err => console.error('Web server error:', err))
})

client.login(process.env.DISCORD_TOKEN)
