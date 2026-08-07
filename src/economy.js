const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const dbPath = path.join(__dirname, '..', 'data', 'economy.json')

const COIN = '🪙'

const ANIMALS = {
  common: [
    { name: 'Cat', value: 10 }, { name: 'Dog', value: 12 }, { name: 'Mouse', value: 8 },
    { name: 'Bird', value: 10 }, { name: 'Rabbit', value: 14 }, { name: 'Fish', value: 8 },
    { name: 'Frog', value: 8 }, { name: 'Duck', value: 12 },
  ],
  uncommon: [
    { name: 'Fox', value: 35 }, { name: 'Penguin', value: 40 }, { name: 'Turtle', value: 30 },
    { name: 'Hedgehog', value: 28 }, { name: 'Squirrel', value: 30 }, { name: 'Otter', value: 45 },
  ],
  rare: [
    { name: 'Wolf', value: 80 }, { name: 'Lion', value: 100 }, { name: 'Eagle', value: 90 },
    { name: 'Deer', value: 75 }, { name: 'Tiger', value: 110 },
  ],
  epic: [
    { name: 'Dragon', value: 250 }, { name: 'Unicorn', value: 220 }, { name: 'Phoenix', value: 280 },
  ],
  legendary: [
    { name: 'God Dog', value: 800 }, { name: 'Shiny Phoenix', value: 1000 }, { name: 'Golden Dragon', value: 1200 },
  ],
}

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary']
const RARITY_CHANCE = [50, 25, 15, 7, 3]
const RARITY_EMOJI = { common: '🟢', uncommon: '🟡', rare: '🔵', epic: '🟣', legendary: '🔴' }
const RARITY_LABEL = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' }

function load() {
  try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')) } catch { return { users: {} } }
}

function save(db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2))
}

function key(guildId, userId) { return `${guildId}:${userId}` }

function getUser(db, guildId, userId) {
  const k = key(guildId, userId)
  if (!db.users[k]) {
    db.users[k] = { balance: 0, xp: 0, lastDaily: null, lastXp: 0, zoo: [] }
  }
  return db.users[k]
}

function rollRarity() {
  let r = Math.random() * 100
  for (let i = 0; i < RARITIES.length; i++) {
    if (r < RARITY_CHANCE[i]) return RARITIES[i]
    r -= RARITY_CHANCE[i]
  }
  return 'common'
}

function randomAnimal() {
  const rarity = rollRarity()
  const list = ANIMALS[rarity]
  const a = list[Math.floor(Math.random() * list.length)]
  return { id: randomUUID(), name: a.name, rarity, value: a.value }
}

function animalLabel(a) {
  return `${RARITY_EMOJI[a.rarity]} ${a.name} (${RARITY_LABEL[a.rarity]})`
}

function zooScore(zoo) {
  return zoo.reduce((sum, a) => sum + a.value, 0)
}

function xpForNextLevel(level) {
  return 100 + (level - 1) * 50
}

function getLevelInfo(xp) {
  let level = 1
  let current = xp
  let need = xpForNextLevel(1)
  while (current >= need) {
    current -= need
    level++
    need = xpForNextLevel(level)
  }
  return { level, current, need }
}

function formatNumber(n) {
  return n.toLocaleString('id-ID')
}

module.exports = {
  COIN, ANIMALS, RARITIES, RARITY_CHANCE, RARITY_EMOJI, RARITY_LABEL,
  load, save, getUser, randomAnimal, animalLabel, zooScore, getLevelInfo, formatNumber,
}
