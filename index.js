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

// ID Configurati del tuo server Golden OP
const AFK_CHANNEL_ID = '1564201037022109727'; 
const CATEGORY_ID = 'METTI_QUI_L_ID_DELLA_CATEGORIA_TAVOLI'; // Fai tasto destro su "tavoli max ~" e incolla l'ID qui dentro!

// I 3 canali pubblici ufficiali dove si possono farmare le Mele d'Oro OP
const PUBLIC_CHANNELS = [
    '1464915715524923581', // Pub 1
    '1464959015065878722', // Pub 2
    '1464959124654657546'  // Pub 3
];

const userXP = new Map(); 
const voiceJoinTime = new Map(); 
const temporaryChannels = new Map(); 

const XP_PER_MINUTE = 10; // 10 Mele d'Oro OP al minuto
const ROOM_COST = 600; // Costo dello shop: 600 Mele d'Oro OP (1 ora)

client.once('ready', async () => {
    console.log(`🤖 Bot Shop & Stanze pronto come ${client.user.tag}!`);
    const shopCommand = new SlashCommandBuilder()
        .setName('shop')
        .setDescription('Compra una stanza vocale temporanea per 600 Mele d\'Oro OP (1 ora in vocale)');
    await client.application.commands.create(shopCommand);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member;
    if (!member || member.user.bot) return;

    const isMuted = newState.selfMute || newState.serverMute;
    const isDeaf = newState.selfDeaf || newState.serverDeaf;

    // 1. SALUTO VOCALE TTS (Funziona in qualsiasi stanza tranne l'AFK)
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

    // 2. CONTROLLO ANTI-AFK (Se si muta totalmente viene cacciato in AFK)
    if (newState.channelId && isMuted && isDeaf && newState.channelId !== AFK_CHANNEL_ID) {
        try {
            await member.voice.setChannel(AFK_CHANNEL_ID);
            voiceJoinTime.delete(member.id);
            await member.send(`💤 Sei stato spostato in AFK perché ti sei mutato del tutto. Il farming di Mele d'Oro OP è sospeso!`).catch(() => {});
        } catch (e) { console.error(e); }
        return;
    }

    // 3. TRACCIAMENTO XP (Solo nelle stanze PUBBLICHE autorizzate)
    // Se entra in uno dei 3 Pub e non è mutato, avvia il timer
    if (!oldState.channelId && newState.channelId && PUBLIC_CHANNELS.includes(newState.channelId) && !(isMuted && isDeaf)) {
        voiceJoinTime.set(member.id, Date.now());
    }
    // Se cambia canale o era già dentro e si sposta
    else if (oldState.channelId && newState.channelId && PUBLIC_CHANNELS.includes(newState.channelId) && !PUBLIC_CHANNELS.includes(oldState.channelId)) {
        if (!(isMuted && isDeaf)) {
            voiceJoinTime.set(member.id, Date.now());
        }
    }

    // Se esce da una stanza pubblica o cambia stato
    if (oldState.channelId && PUBLIC_CHANNELS.includes(oldState.channelId)) {
        // Se esce del tutto o si sposta in un canale non abilitato o si muta
        if (!newState.channelId || !PUBLIC_CHANNELS.includes(newState.channelId) || (isMuted && isDeaf)) {
            const joinTime = voiceJoinTime.get(member.id);
            if (joinTime) {
                const minutes = Math.floor((Date.now() - joinTime) / 60000);
                if (minutes > 0) {
                    const gained = minutes * XP_PER_MINUTE;
                    userXP.set(member.id, (userXP.get(member.id) || 0) + gained);
                    await member.send(`💰 Hai guadagnato **${gained} Mele d'Oro OP**! Totale attuale: **${userXP.get(member.id)}**.`).catch(() => {});
                }
                voiceJoinTime.delete(member.id);
            }
        }
    }

    // 4. AUTO-DISTRUZIONE STANZE TEMPORANEE
    if (oldState.channelId && temporaryChannels.has(oldState.channelId)) {
        const tempChannel = oldState.guild.channels.cache.get(oldState.channelId);
        if (tempChannel && tempChannel.members.size === 0) {
            tempChannel.delete()
                .then(() => temporaryChannels.delete(oldState.channelId))
                .catch(console.error);
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'shop') {
        const userId = interaction.user.id;
        const currentXP = userXP.get(userId) || 0;
        if (currentXP < ROOM_COST) {
            return interaction.reply({ content: `❌ Ti servono **${ROOM_COST} Mele d'Oro OP**. Al momento ne hai: **${currentXP}**.`, ephemeral: true });
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
            await interaction.reply({ content: `🎉 Stanza temporanea **${newChannel.name}** creata con successo! Svanirà quando usciranno tutti.`, ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: `❌ Errore durante la creazione della stanza. Controlla i permessi del bot.`, ephemeral: true });
        }
    }
});

client.login(process.env.TOKEN);

