const { Client, GatewayIntentBits, SlashCommandBuilder, ChannelType } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const googleTTS = require('google-tts-api');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ⚠️ INSERISCI QUI SOTTO I TUOI ID DI DISCORD TRA GLI APICI ''
const AFK_CHANNEL_ID = 'INSERISCI_QUI_L_ID_DEL_TUO_CANALE_AFK'; 
const CATEGORY_ID = 'INSERISCI_QUI_L_ID_DELLA_CATEGORIA_STANZE'; 

const userXP = new Map(); 
const voiceJoinTime = new Map(); 
const temporaryChannels = new Map(); 

const XP_PER_MINUTE = 10;
const ROOM_COST = 600; 

client.once('ready', async () => {
    console.log(`🤖 Bot Shop & Stanze pronto come ${client.user.tag}!`);
    const shopCommand = new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Compra una stanza vocale temporanea per 600 XP (1 ora in vocale)');
    await client.application.commands.create(shopCommand);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const isMuted = newState.selfMute || newState.serverMute;
    const isDeaf = newState.selfDeaf || newState.serverDeaf;

    // 1. SALUTO VOCALE TTS
    if (!oldState.channelId && newState.channelId && newState.channelId !== AFK_CHANNEL_ID) {
        try {
            const connection = joinVoiceChannel({
                channelId: newState.channel.id,
                guildId: newState.guild.id,
                adapterCreator: newState.channel.voiceAdapterCreator,
            });
            const url = googleTTS.getAudioUrl(`Benvenuto nella stanza, ${member.displayName}!`, {
                lang: 'it',
                slow: false,
                host: 'https://google.com',
            });
            const player = createAudioPlayer();
            const resource = createAudioResource(url);
            player.play(resource);
            connection.subscribe(player);
            player.on(AudioPlayerStatus.Idle, () => {
                setTimeout(() => { if (newState.channel.members.size <= 1) connection.destroy(); }, 2000);
            });
        } catch (e) { console.error(e); }
    }

    // 2. CONTROLLO ANTI-AFK
    if (newState.channelId && isMuted && isDeaf && newState.channelId !== AFK_CHANNEL_ID) {
        try {
            await member.voice.setChannel(AFK_CHANNEL_ID);
            voiceJoinTime.delete(member.id);
            await member.send(`💤 Spostato in AFK. Guadagno XP sospeso!`).catch(() => {});
        } catch (e) { console.error(e); }
        return;
    }

    // 3. TRACCIAMENTO XP
    if (!oldState.channelId && newState.channelId && newState.channelId !== AFK_CHANNEL_ID) {
        if (!temporaryChannels.has(newState.channelId)) {
            voiceJoinTime.set(member.id, Date.now());
        }
    }

    if (oldState.channelId && (!newState.channelId || oldState.channelId !== newState.channelId)) {
        const joinTime = voiceJoinTime.get(member.id);
        if (joinTime) {
            const minutes = Math.floor((Date.now() - joinTime) / 60000);
            if (minutes > 0) {
                const gained = minutes * XP_PER_MINUTE;
                userXP.set(member.id, (userXP.get(member.id) || 0) + gained);
            }
            voiceJoinTime.delete(member.id);
        }
        if (newState.channelId === AFK_CHANNEL_ID) voiceJoinTime.delete(member.id);

        // AUTO-DISTRUZIONE STANZE TEMPORANEE
        if (temporaryChannels.has(oldState.channelId)) {
            const tempChannel = oldState.guild.channels.cache.get(oldState.channelId);
            if (tempChannel && tempChannel.members.size === 0) {
                tempChannel.delete().then(() => temporaryChannels.delete(oldState.channelId)).catch(console.error);
            }
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'shop') {
        const userId = interaction.user.id;
        const currentXP = userXP.get(userId) || 0;
        if (currentXP < ROOM_COST) {
            return interaction.reply({ content: `❌ Ti servono **${ROOM_COST} XP**. Hai: **${currentXP} XP**.`, ephemeral: true });
        }
        userXP.set(userId, currentXP - ROOM_COST);
        try {
            const newChannel = await interaction.guild.channels.create({
                name: `🔒 Stanza di ${interaction.user.username}`,
                type: ChannelType.GuildVoice,
                parent: CATEGORY_ID,
                permissionOverwrites: [
                    { id: interaction.guild.id, allow: ['ViewChannel', 'Connect'] },
                    { id: userId, allow: ['ManageChannels', 'MoveMembers', 'MuteMembers'] }
                ]
            });
            temporaryChannels.set(newChannel.id, userId);
            await interaction.reply({ content: `🎉 Stanza **${newChannel.name}** creata!`, ephemeral: true });
        } catch (e) {
            await interaction.reply({ content: `❌ Errore creazione stanza.`, ephemeral: true });
        }
    }
});

client.login(process.env.TOKEN);
