// =====================================================================
//  BOT DISCORD: Benvenuto vocale + XP + Anti-AFK + Shop stanze temporanee
//  Richiede: discord.js v14, @discordjs/voice, google-tts-api
// =====================================================================
 
const fs = require('fs');
const path = require('path');
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
//  CONFIGURAZIONE  (l'unica parte che DEVI modificare è il TOKEN)
// =====================================================================
const CONFIG = {
  // Incolla qui il token del bot (tra gli apici). NON condividerlo con nessuno!
  TOKEN: 'INCOLLA_QUI_IL_TUO_TOKEN',
 
  // Nome della categoria dove nascono le stanze temporanee.
  // Se non esiste, il bot la crea da solo.
  CATEGORY_NAME: 'Stanze Temporanee',
 
  ROOM_PRICE: 600,      // costo della stanza in XP (600 XP = 1 ora)
  XP_PER_MINUTE: 10,    // XP guadagnati ogni minuto in vocale
 
  // false = saluta ogni volta che l'utente entra in vocale "da fuori"
  // true  = saluta una sola volta finché il bot resta acceso
  WELCOME_ONLY_ONCE_PER_BOT_RUN: false,
 
  // Se compri la stanza e nessuno entra entro X minuti, viene cancellata
  // e ricevi il rimborso degli XP.
  EMPTY_ROOM_TIMEOUT_MIN: 5,
};
 
// =====================================================================
//  SALVATAGGIO DATI (file data.json nella stessa cartella)
// =====================================================================
const DATA_FILE = path.join(__dirname, 'data.json');
 
// xp:    { "idServer:idUtente": numero }
// rooms: { "idCanale": { guildId, ownerId } }
let data = { xp: {}, rooms: {} };
 
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data = { xp: loaded.xp || {}, rooms: loaded.rooms || {} };
  }
} catch (err) {
  console.error('⚠️ Impossibile leggere data.json, riparto da zero:', err);
}
 
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('⚠️ Impossibile salvare data.json:', err);
  }
}
 
const xpKey = (guildId, userId) => `${guildId}:${userId}`;
 
// =====================================================================
//  CLIENT DISCORD
//  Servono solo 2 intent normali (NON privilegiati).
// =====================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
 
// =====================================================================
//  1) BENVENUTO VOCALE (TTS)
// =====================================================================
const welcomeQueues = new Map(); // una coda per ogni server
const welcomedUsers = new Set(); // per l'opzione "una volta sola"
 
function cleanName(name) {
  const cleaned = name
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'amico';
}
 
async function speakInChannel(channel, text) {
  // Se nel frattempo la stanza si è svuotata, lascia perdere.
  if (!channel.members || !channel.members.some((m) => !m.user.bot)) return;
 
  // Scarica l'audio TTS (italiano) da Google Translate
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
    connection.destroy(); // si disconnette sempre, anche in caso di errore
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
//  2) ANTI-AFK
// =====================================================================
// Sposta nel canale AFK chi ha microfono E cuffie disattivati.
// Restituisce true se l'utente è stato spostato.
async function checkAntiAfk(voiceState) {
  const guild = voiceState.guild;
  if (!voiceState.channelId || !guild.afkChannelId) return false;
  if (voiceState.channelId === guild.afkChannelId) return false;
 
  if (voiceState.selfMute && voiceState.selfDeaf) {
    try {
      await voiceState.setChannel(guild.afkChannelId, 'Anti-AFK: muto e con cuffie spente');
      return true;
    } catch (err) {
      console.error('⚠️ Impossibile spostare in AFK (permessi mancanti?):', err.message);
    }
  }
  return false;
}
 
// Ogni minuto: assegna XP. Per essere "onesti", l'XP viene dato solo a chi
// era idoneo anche al minuto precedente (niente XP entrando 1 secondo prima).
let eligibleLastTick = new Set();
 
function xpTick() {
  const eligibleNow = new Set();
 
  for (const guild of client.guilds.cache.values()) {
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || !vs.member || vs.member.user.bot) continue;
 
      // Nel canale AFK: nessun XP
      if (vs.channelId === guild.afkChannelId) continue;
 
      // Controllo anti-AFK anche durante il giro dei minuti
      checkAntiAfk(vs).catch(() => {});
 
      // Nessun XP se è mutato (microfono o cuffie, da sé o dal server)
      if (vs.selfMute || vs.serverMute || vs.selfDeaf || vs.serverDeaf) continue;
 
      const key = xpKey(guild.id, vs.id);
      eligibleNow.add(key);
 
      if (eligibleLastTick.has(key)) {
        data.xp[key] = (data.xp[key] || 0) + CONFIG.XP_PER_MINUTE;
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
  if (!channel || !data.rooms[channel.id]) return false; // non è una stanza temporanea
 
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
    const isAfkChannel = newState.channelId === guild.afkChannelId;
 
    if (enteredFromOutside && !isAfkChannel && !movedToAfk) {
      const key = xpKey(guild.id, member.id);
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
 
// Se una stanza temporanea viene cancellata a mano, la togliamo dai dati
client.on(Events.ChannelDelete, (channel) => {
  if (data.rooms[channel.id]) {
    delete data.rooms[channel.id];
    saveData();
  }
});
 
// =====================================================================
//  3) COMANDO /shop
// =====================================================================
const shopCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription(`Compra una stanza vocale temporanea (${CONFIG.ROOM_PRICE} XP)`)
  .addStringOption((opt) =>
    opt
      .setName('nome')
      .setDescription('Nome della stanza (facoltativo)')
      .setMaxLength(50)
  );
 
async function registerCommands(guild) {
  try {
    await guild.commands.set([shopCommand.toJSON()]);
    console.log(`📌 Comandi registrati nel server: ${guild.name}`);
  } catch (err) {
    console.error(`⚠️ Registrazione comandi fallita in ${guild.name}:`, err.message);
  }
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
 
const buying = new Set(); // evita doppi acquisti simultanei
 
async function handleShop(interaction) {
  const { guild, user, member } = interaction;
  const ephemeral = MessageFlags.Ephemeral;
 
  if (!guild) {
    return interaction.reply({ content: 'Questo comando funziona solo dentro un server.', flags: ephemeral });
  }
 
  const key = xpKey(guild.id, user.id);
 
  if (buying.has(key)) {
    return interaction.reply({ content: 'Un attimo, sto già elaborando il tuo acquisto…', flags: ephemeral });
  }
 
  // Ha già una stanza?
  const owned = Object.entries(data.rooms).find(
    ([, r]) => r.guildId === guild.id && r.ownerId === user.id
  );
  if (owned) {
    return interaction.reply({ content: `Hai già una stanza temporanea: <#${owned[0]}>`, flags: ephemeral });
  }
 
  // Ha abbastanza XP?
  const xp = data.xp[key] || 0;
  if (xp < CONFIG.ROOM_PRICE) {
    const missing = CONFIG.ROOM_PRICE - xp;
    const minutes = Math.ceil(missing / CONFIG.XP_PER_MINUTE);
    return interaction.reply({
      content:
        `❌ Non hai abbastanza XP.\n` +
        `Hai **${xp} XP**, ne servono **${CONFIG.ROOM_PRICE}**.\n` +
        `Te ne mancano ${missing} (circa ${minutes} minuti in vocale non mutato).`,
      flags: ephemeral,
    });
  }
 
  // Scala subito gli XP (prima di qualsiasi attesa) per evitare trucchi
  buying.add(key);
  data.xp[key] = xp - CONFIG.ROOM_PRICE;
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
        // Il creatore ha i poteri di gestione sulla sua stanza
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
        // Il bot deve poter gestire la stanza (e cancellarla)
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
 
    // Se il creatore è già in vocale, lo spostiamo nella nuova stanza
    if (member.voice && member.voice.channelId) {
      await member.voice.setChannel(channel).catch(() => {});
    }
 
    // Se nessuno entra entro X minuti: cancella la stanza e rimborsa
    setTimeout(async () => {
      const room = data.rooms[channel.id];
      if (!room) return;
      const ch = await client.channels.fetch(channel.id).catch(() => null);
      if (!ch) return;
      const deleted = await deleteRoomIfEmpty(ch);
      if (deleted) {
        data.xp[key] = (data.xp[key] || 0) + CONFIG.ROOM_PRICE;
        saveData();
        console.log(`↩️ Rimborso a ${user.tag}: stanza mai usata.`);
      }
    }, CONFIG.EMPTY_ROOM_TIMEOUT_MIN * 60_000);
 
    await interaction.editReply(
      `✅ Stanza creata: <#${channel.id}>\n` +
        `Hai speso ${CONFIG.ROOM_PRICE} XP (te ne restano ${data.xp[key]}).\n` +
        `Entra entro ${CONFIG.EMPTY_ROOM_TIMEOUT_MIN} minuti, altrimenti viene cancellata e ti rimborso.\n` +
        `Quando l'ultima persona esce, la stanza si cancella da sola.`
    );
  } catch (err) {
    console.error('⚠️ Errore durante /shop:', err);
    // Qualcosa è andato storto: rimborso
    data.xp[key] = (data.xp[key] || 0) + CONFIG.ROOM_PRICE;
    saveData();
    await interaction
      .editReply('❌ Non sono riuscito a creare la stanza (controlla i permessi del bot). Ti ho rimborsato gli XP.')
      .catch(() => {});
  } finally {
    buying.delete(key);
  }
}
 
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
      await handleShop(interaction);
    }
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
      delete data.rooms[id]; // il canale non esiste più
      continue;
    }
    await deleteRoomIfEmpty(ch); // se è vuota la cancella
  }
  saveData();
}
 
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online come ${c.user.tag}`);
 
  for (const guild of c.guilds.cache.values()) {
    await registerCommands(guild);
  }
  await cleanupRoomsAtStartup();
 
  setInterval(xpTick, 60_000);
});
 
client.on(Events.GuildCreate, registerCommands);
 
process.on('unhandledRejection', (err) => console.error('⚠️ Errore non gestito:', err));
 
if (!CONFIG.TOKEN || CONFIG.TOKEN === 'INCOLLA_QUI_IL_TUO_TOKEN') {
  console.error('❌ Devi incollare il token del bot nella variabile CONFIG.TOKEN (in cima al file).');
  process.exit(1);
}
 
client.login(CONFIG.TOKEN);

