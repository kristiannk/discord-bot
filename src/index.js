const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js')
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice')
const { spawn } = require('child_process')
const path = require('path')
const play = require('play-dl')
require('dotenv').config()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
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

const ytDlpBin = path.join(
  __dirname, '..', 'node_modules', '@distube', 'yt-dlp', 'bin',
  `yt-dlp${process.platform === 'win32' ? '.exe' : ''}`
)

const YT_API_KEY = process.env.YT_API_KEY
const cookiesPath = path.join(__dirname, '..', 'cookies.txt')

const queue = new Map()
const activeProcesses = new Map()

function getQueue(guildId) {
  if (!queue.has(guildId)) {
    queue.set(guildId, { songs: [], player: null, connection: null, playing: false })
  }
  return queue.get(guildId)
}

async function getYtInfo(url) {
  const args = ['-f', 'bestaudio', '--print-json', '--no-warnings']
  if (require('fs').existsSync(cookiesPath)) args.push('--cookies', cookiesPath)
  return new Promise((resolve, reject) => {
    const proc = spawn(ytDlpBin, [...args, url])
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

    const streamArgs = ['-f', 'bestaudio', '-o', '-', '--no-warnings']
    if (require('fs').existsSync(cookiesPath)) streamArgs.push('--cookies', cookiesPath)
    const proc = spawn(ytDlpBin, [...streamArgs, song.url])

    activeProcesses.set(guildId, proc)

    const resource = createAudioResource(proc.stdout, { inputType: 'arbitrary' })
    q.player.play(resource)

    proc.on('error', () => {
      q.songs.shift()
      playSong(guildId)
    })

    proc.on('close', code => {
      if (code !== 0 && code !== null) {
        console.error(`yt-dlp exited with code ${code}`)
      }
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
].map(cmd => cmd.toJSON())

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
        q.songs.shift()
        playSong(guildId)
      })
      q.player.on('error', error => {
        console.error('Player error:', error)
        const proc = activeProcesses.get(guildId)
        if (proc) { proc.kill(); activeProcesses.delete(guildId) }
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
})

client.login(process.env.DISCORD_TOKEN)
