// =====================================================================
//  BOT DISCORD: Benvenuto vocale + Mele d'oro + Anti-AFK + Shop stanze
//  Pensato per Render (piano gratuito) + Upstash Redis (salvataggio)
// =====================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');

const googleTTS = require('google-tts-api');

// =====================================================================
//  CONFIGURAZIONE
// =====================================================================
const CONFIG = {
  // Il token va messo su Render (Environment → DISCORD_TOKEN), NON qui.
  // Il valore scritto qui serve solo se lo avvii sul tuo PC.
  TOKEN: process.env.DISCORD_TOKEN || 'INCOLLA_QUI_IL_TUO_TOKEN',

  // Le 3 stanze pub dove si guadagnano le mele d'oro
  EARN_CHANNEL_IDS: [
    '1464915715524923581', // pub 1
    '1464959015065878722', // pub 2
    '1464959124654657546', // pub 3
  ],

  // Canale AFK dove il bot sposta chi è muto sia col microfono che con le cuffie
  AFK_CHANNEL_ID: '1564201037022109727',

  MINUTES_PER_APPLE: 10,   // 1 mela d'oro ogni 10 minuti
  ROOM_PRICE: 100,         // costo della stanza temporanea in mele d'oro

  // Categoria dove nascono le stanze temporanee (se non esiste la crea il bot)
  CATEGORY_NAME: 'Stanze Temporanee',

  // false = saluta ogni volta che l'utente entra in vocale "da fuori"
  // true  = saluta una sola volta finché il bot resta acceso
  WELCOME_ONLY_ONCE_PER_BOT_RUN: false,

  // Se compri la stanza e nessuno entra entro X minuti, viene cancellata
  // e ricevi il rimborso delle mele.
  EMPTY_ROOM_TIMEOUT_MIN: 5,
};

// =====================================================================
//  SERVER WEB (serve a Render, e a UptimeRobot per non farlo addormentare)
// =====================================================================
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot attivo ✅');
  })
  .listen(process.env.PORT || 3000, () => console.log('🌐 Server web attivo'));

// =====================================================================
//  SALVATAGGIO DATI
//  - Se ci sono le variabili UPSTASH_*, salva su Upstash Redis (consigliato)
//  - Altrimenti salva su data.json (su Render gratuito si cancella!)
// =====================================================================
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const DATA_FILE = path.join(__dirname, 'data.json');
const REDIS_KEY = 'bot_data';

// apples:   { "idServer:idUtente": mele }
// progress: { "idServer:idUtente": minuti accumulati verso la prossima mela }
// rooms:    { "idCanale": { guildId, ownerId } }
let data = { apples: {}, progress: {}, rooms: {} };
let dirty = false;
let flushing = false;

async function redisCommand(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}

function normalizeData(obj) {
  return {
    apples: (obj && obj.apples) || {},
    progress: (obj && obj.progress) || {},
    rooms: (obj && obj.rooms) || {},
  };
}

async function loadData() {
  try {
    if (USE_REDIS) {
      const raw = await redisCommand(['GET', REDIS_KEY]);
      if (raw) data = normalizeData(JSON.parse(raw));
      console.log('💾 Dati caricati da Upstash Redis');
    } else {
      if (fs.existsSync(DATA_FILE)) {
        data = normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      }
      console.log('⚠️ Upstash non configurato: uso data.json (su Render i dati si perdono ai riavvii!)');
    }
  } catch (err) {
    console.error('⚠️ Errore nel caricamento dei dati:', err.message);
  }
}

function saveData() {
  dirty = true; // il salvataggio vero lo fa flushData() ogni pochi secondi
}

async function flushData() {
  if (!dirty || flushing) return;
  flushing = true;
  dirty = false;
  try {
    const json = JSON.stringify(data);
    if (USE_REDIS) {
      await redisCommand(['SET', REDIS_KEY, json]);
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    dirty = true; // riprova al prossimo giro
    console.error('⚠️ Errore nel salvataggio dei dati:', err.message);
  } finally {
    flushing = false;
  }
}

const userKey = (guildId, userId) => `${guildId}:${userId}`;
const getApples = (key) => data.apples[key] || 0;

// =====================================================================
//  CLIENT DISCORD (solo intent normali, nessun Privileged Intent)
// =====================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// =====================================================================
//  1) BENVENUTO VOCALE (TTS)
// =====================================================================
const welcomeQueues = new Map();
const welcomedUsers = new Set();

function cleanName(name) {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'amico';
}

async function speakInChannel(channel, text) {
  if (!channel.members || !channel.members.some((m) => !m.user.bot)) return;

  const url = googleTTS.getAudioUrl(text, {
    lang: 'it',
    slow: false,
    host: 'https://translate.google.com',
  });
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Download TTS fallito (HTTP ${res.status})`);
  const audioBuffer = Buffer.from(await res.arrayBuffer());

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const player = createAudioPlayer();
    connection.subscribe(player);
    player.play(createAudioResource(Readable.from(audioBuffer)));

    await entersState(player, AudioPlayerStatus.Playing, 10_000);
    await entersState(player, AudioPlayerStatus.Idle, 30_000);
  } finally {
    connection.destroy();
  }
}

function enqueueWelcome(channel, text) {
  const guildId = channel.guild.id;
  const previous = welcomeQueues.get(guildId) || Promise.resolve();
  const next = previous
    .then(() => speakInChannel(channel, text))
    .catch((err) => console.error('⚠️ Errore benvenuto vocale:', err.message));
  welcomeQueues.set(guildId, next);
}

// =====================================================================
//  2) ANTI-AFK + MELE D'ORO
// =====================================================================
const isEarnChannel = (channelId) => CONFIG.EARN_CHANNEL_IDS.includes(channelId);
const isTempRoom = (channelId) => Boolean(data.rooms[channelId]);
// Il controllo anti-AFK vale nelle stanze pub e nelle stanze temporanee
const isMonitored = (channelId) => isEarnChannel(channelId) || isTempRoom(channelId);

// Sposta nel canale AFK chi ha microfono E cuffie disattivati.
// Restituisce true se l'utente è stato spostato.
async function checkAntiAfk(voiceState) {
  if (!voiceState.channelId) return false;
  if (voiceState.channelId === CONFIG.AFK_CHANNEL_ID) return false;
  if (!isMonitored(voiceState.channelId)) return false;

  if (voiceState.selfMute && voiceState.selfDeaf) {
    try {
      await voiceState.setChannel(CONFIG.AFK_CHANNEL_ID, 'Anti-AFK: muto e con cuffie spente');
      return true;
    } catch (err) {
      console.error('⚠️ Impossibile spostare in AFK (permessi o ID canale errato?):', err.message);
    }
  }
  return false;
}

// Ogni minuto: conta i minuti validi. Ogni 10 minuti validi = 1 mela d'oro.
// Per essere "onesti", il minuto conta solo se l'utente era idoneo
// anche al giro precedente (niente mele entrando 1 secondo prima).
let eligibleLastTick = new Set();

function appleTick() {
  const eligibleNow = new Set();

  for (const guild of client.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || !vs.member || vs.member.user.bot) continue;

      // Controllo anti-AFK anche durante il giro dei minuti
      checkAntiAfk(vs).catch(() => {});

      // Le mele si guadagnano solo nelle 3 stanze pub
      if (!isEarnChannel(vs.channelId)) continue;

      // Nessuna mela se è mutato (microfono o cuffie, da sé o dal server)
      if (vs.selfMute || vs.serverMute || vs.selfDeaf || vs.serverDeaf) continue;

      const key = userKey(guild.id, vs.id);
      eligibleNow.add(key);

      if (eligibleLastTick.has(key)) {
        const minutes = (data.progress[key] || 0) + 1;
        if (minutes >= CONFIG.MINUTES_PER_APPLE) {
          data.apples[key] = getApples(key) + 1;
          data.progress[key] = 0;
        } else {
          data.progress[key] = minutes;
        }
      }
    }
  }

  eligibleLastTick = eligibleNow;
  saveData();
}

// =====================================================================
//  4) AUTO-DISTRUZIONE STANZE TEMPORANEE
// =====================================================================
async function deleteRoomIfEmpty(channel) {
  if (!channel || !data.rooms[channel.id]) return false;

  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size > 0) return false;

  delete data.rooms[channel.id];
  saveData();

  try {
    await channel.delete('Stanza temporanea vuota');
  } catch (err) {
    console.error('⚠️ Impossibile cancellare la stanza:', err.message);
  }
  return true;
}

// =====================================================================
//  EVENTO PRINCIPALE: cambi di stato nelle stanze vocali
// =====================================================================
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const guild = newState.guild;

    // --- Anti-AFK (prima di tutto) ---
    const movedToAfk = await checkAntiAfk(newState);

    // --- 1) Benvenuto vocale ---
    const enteredFromOutside = !oldState.channelId && newState.channelId;
    const isAfkChannel = newState.channelId === CONFIG.AFK_CHANNEL_ID;

    if (enteredFromOutside && !isAfkChannel && !movedToAfk) {
      const key = userKey(guild.id, member.id);
      const alreadyWelcomed = CONFIG.WELCOME_ONLY_ONCE_PER_BOT_RUN && welcomedUsers.has(key);

      if (!alreadyWelcomed) {
        welcomedUsers.add(key);
        enqueueWelcome(newState.channel, `Benvenuto nella stanza, ${cleanName(member.displayName)}!`);
      }
    }

    // --- 4) Auto-distruzione: qualcuno ha lasciato una stanza ---
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await deleteRoomIfEmpty(oldState.channel);
    }
  } catch (err) {
    console.error('⚠️ Errore in VoiceStateUpdate:', err);
  }
});

client.on(Events.ChannelDelete, (channel) => {
  if (data.rooms[channel.id]) {
    delete data.rooms[channel.id];
    saveData();
  }
});

// =====================================================================
//  COMANDI: /mele (vedi il tuo saldo) e /shop (compra la stanza)
// =====================================================================
const meleCommand = new SlashCommandBuilder()
  .setName('mele')
  .setDescription("Guarda quante mele d'oro hai");

const shopCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription(`Compra una stanza vocale temporanea (${CONFIG.ROOM_PRICE} mele d'oro)`)
  .addStringOption((opt) =>
    opt.setName('nome').setDescription('Nome della stanza (facoltativo)').setMaxLength(50)
  );

async function registerCommands(guild) {
  try {
    await guild.commands.set([meleCommand.toJSON(), shopCommand.toJSON()]);
    console.log(`📌 Comandi registrati nel server: ${guild.name}`);
  } catch (err) {
    console.error(`⚠️ Registrazione comandi fallita in ${guild.name}:`, err.message);
  }
}

async function handleMele(interaction) {
  const { guild, user } = interaction;
  if (!guild) {
    return interaction.reply({ content: 'Questo comando funziona solo dentro un server.', flags: MessageFlags.Ephemeral });
  }

  const key = userKey(guild.id, user.id);
  const apples = getApples(key);
  const minutes = data.progress[key] || 0;
  const minutesLeft = CONFIG.MINUTES_PER_APPLE - minutes;
  const missing = CONFIG.ROOM_PRICE - apples;

  let text = `🍎 Hai **${apples}** mele d'oro.\n`;
  text += `⏱️ Prossima mela tra circa **${minutesLeft}** minuti (in una stanza pub, non mutato).\n`;
  if (missing > 0) {
    text += `🛒 Per la stanza temporanea (${CONFIG.ROOM_PRICE} mele) te ne mancano **${missing}**.`;
  } else {
    text += `🛒 Hai abbastanza mele per la stanza temporanea! Usa **/shop**.`;
  }

  return interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
}

async function getOrCreateCategory(guild) {
  await guild.channels.fetch();
  let category = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildCategory &&
      c.name.toLowerCase() === CONFIG.CATEGORY_NAME.toLowerCase()
  );
  if (!category) {
    category = await guild.channels.create({
      name: CONFIG.CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
  }
  return category;
}

const buying = new Set();

async function handleShop(interaction) {
  const { guild, user, member } = interaction;
  const ephemeral = MessageFlags.Ephemeral;

  if (!guild) {
    return interaction.reply({ content: 'Questo comando funziona solo dentro un server.', flags: ephemeral });
  }

  const key = userKey(guild.id, user.id);

  if (buying.has(key)) {
    return interaction.reply({ content: 'Un attimo, sto già elaborando il tuo acquisto…', flags: ephemeral });
  }

  const owned = Object.entries(data.rooms).find(
    ([, r]) => r.guildId === guild.id && r.ownerId === user.id
  );
  if (owned) {
    return interaction.reply({ content: `Hai già una stanza temporanea: <#${owned[0]}>`, flags: ephemeral });
  }

  const apples = getApples(key);
  if (apples < CONFIG.ROOM_PRICE) {
    return interaction.reply({
      content:
        `❌ Non hai abbastanza mele d'oro.\n` +
        `Hai **${apples} 🍎**, ne servono **${CONFIG.ROOM_PRICE}**. Te ne mancano ${CONFIG.ROOM_PRICE - apples}.`,
      flags: ephemeral,
    });
  }

  // Scala subito le mele (prima di qualsiasi attesa) per evitare trucchi
  buying.add(key);
  data.apples[key] = apples - CONFIG.ROOM_PRICE;
  saveData();

  await interaction.deferReply({ flags: ephemeral });

  try {
    const category = await getOrCreateCategory(guild);

    const requestedName = interaction.options.getString('nome');
    const roomName = (requestedName || `Stanza di ${member.displayName}`).slice(0, 100);

    const channel = await guild.channels.create({
      name: roomName,
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: `Stanza acquistata da ${user.tag}`,
      permissionOverwrites: [
        {
          id: user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
            PermissionFlagsBits.MoveMembers,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
          ],
        },
      ],
    });

    data.rooms[channel.id] = { guildId: guild.id, ownerId: user.id };
    saveData();

    if (member.voice && member.voice.channelId) {
      await member.voice.setChannel(channel).catch(() => {});
    }

    // Se nessuno entra entro X minuti: cancella la stanza e rimborsa
    setTimeout(async () => {
      if (!data.rooms[channel.id]) return;
      const ch = await client.channels.fetch(channel.id).catch(() => null);
      if (!ch) return;
      const deleted = await deleteRoomIfEmpty(ch);
      if (deleted) {
        data.apples[key] = getApples(key) + CONFIG.ROOM_PRICE;
        saveData();
        console.log(`↩️ Rimborso a ${user.tag}: stanza mai usata.`);
      }
    }, CONFIG.EMPTY_ROOM_TIMEOUT_MIN * 60_000);

    await interaction.editReply(
      `✅ Stanza creata: <#${channel.id}>\n` +
        `Hai speso ${CONFIG.ROOM_PRICE} 🍎 (te ne restano ${data.apples[key]}).\n` +
        `Entra entro ${CONFIG.EMPTY_ROOM_TIMEOUT_MIN} minuti, altrimenti viene cancellata e ti rimborso.\n` +
        `Quando l'ultima persona esce, la stanza si cancella da sola.`
    );
  } catch (err) {
    console.error('⚠️ Errore durante /shop:', err);
    data.apples[key] = getApples(key) + CONFIG.ROOM_PRICE;
    saveData();
    await interaction
      .editReply('❌ Non sono riuscito a creare la stanza (controlla i permessi del bot). Ti ho rimborsato le mele.')
      .catch(() => {});
  } finally {
    buying.delete(key);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'mele') await handleMele(interaction);
    if (interaction.commandName === 'shop') await handleShop(interaction);
  } catch (err) {
    console.error('⚠️ Errore interazione:', err);
  }
});

// =====================================================================
//  AVVIO
// =====================================================================
async function cleanupRoomsAtStartup() {
  for (const id of Object.keys(data.rooms)) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch) {
      delete data.rooms[id];
      continue;
    }
    await deleteRoomIfEmpty(ch);
  }
  saveData();
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online come ${c.user.tag}`);

  for (const guild of c.guilds.cache.values()) {
    await registerCommands(guild);
  }
  await cleanupRoomsAtStartup();

  setInterval(appleTick, 60_000);
});

client.on(Events.GuildCreate, registerCommands);

// Salvataggio periodico, e salvataggio finale quando Render ferma il bot
setInterval(flushData, 10_000);
async function shutdown() {
  console.log('🛑 Arresto in corso, salvo i dati…');
  dirty = true;
  flushing = false;
  await flushData();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => console.error('⚠️ Errore non gestito:', err));

async function main() {
  if (!CONFIG.TOKEN || CONFIG.TOKEN === 'INCOLLA_QUI_IL_TUO_TOKEN') {
    console.error('❌ Manca il token: imposta la variabile DISCORD_TOKEN su Render.');
    process.exit(1);
  }
  await loadData();
  await client.login(CONFIG.TOKEN);
}

main();

