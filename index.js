const { Client, GatewayIntentBits, SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
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

// ID REALI E CONFIGURATI DEL TUO SERVER GOLDEN OP
const AFK_CHANNEL_ID = '1564201037022109727'; 
const CATEGORY_ID = '1464915600000000000'; // <--- SISTEMATO: Sostituisci questo numero con l'ID reale della categoria "tavoli max ~"

// I 3 canali pubblici ufficiali dove si possono farmare le Mele d'Oro OP
const PUBLIC_CHANNELS = [
    '1464915715524923581', // Pub 1
    '1464959015065878722', // Pub 2
    '1464959124654657546'  // Pub 3
];

const userXP = new Map(); 
const voiceJoinTime = new Map(); 
const temporaryChannels = new Map(); 

const XP_PER_MINUTE = 10; 
const ROOM_COST = 600; 

client.once('ready', async () => {
    console.log(`🤖 Bot Shop & Stanze pronto come ${client.user.tag}!`);
    try {
        const shopCommand = new SlashCommandBuilder()
            .setName('shop')
            .setDescription('Compra una stanza vocale temporanea per 600 Mele d\'Oro OP (1 ora in vocale)');
        
        await client.application.commands.create(shopCommand);
        console.log('✅ Comando /shop registrato con successo globale!');
    } catch (error) {
        console.error('Errore durante la registrazione dei comandi:', error);
    }
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
                setTimeout(() => { 
                    if (newState.channel && newState.channel.members.size <= 1) {
                        connection.destroy(); 
                    }
                }, 2000);
            });
        } catch (e) { console.error('Errore TTS:', e); }
    }

    // 2. CONTROLLO ANTI-AFK
    if (newState.channelId && isMuted && isDeaf && newState.channelId !== AFK_CHANNEL_ID) {
        try {
            await member.voice.setChannel(AFK_CHANNEL_ID);
            voiceJoinTime.delete(member.id);
            await member.send(`💤 Sei stato spostato in AFK perché ti sei mutato del tutto. Il farming di Mele d'Oro OP è sospeso!`).catch(() => {});
        } catch (e) { console.error('Errore spostamento AFK (Verifica i permessi del bot):', e); }
        return;
    }

    // 3. TRACCIAMENTO XP
    if (!oldState.channelId && newState.channelId && PUBLIC_CHANNELS.includes(newState.channelId) && !(isMuted && isDeaf)) {
        voiceJoinTime.set(member.id, Date.now());
    }
    else if (oldState.channelId && newState.channelId && PUBLIC_CHANNELS.includes(newState.channelId) && !PUBLIC_CHANNELS.includes(oldState.channelId)) {
        if (!(isMuted && isDeaf)) {
            voiceJoinTime.set(member.id, Date.now());
        }
    }

    if (oldState.channelId && PUBLIC_CHANNELS.includes(oldState.channelId)) {
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

        // Evita il timeout di Discord differendo la risposta
        await interaction.deferReply({ ephemeral: true });

        try {
            const newChannel = await interaction.guild.channels.create({
                name: `🔒 Stanza di ${interaction.user.username}`,
                type: ChannelType.GuildVoice,
                parent: CATEGORY_ID,
                permissionOverwrites: [
                    { 
                        id: interaction.guild.id, 
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] 
                    },
                    { 
                        id: userId, 
                        allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.MuteMembers] 
                    }
                ]
            });

            userXP.set(userId, currentXP - ROOM_COST);
            temporaryChannels.set(newChannel.id, userId);

            await interaction.editReply({ content: `🎉 Stanza temporanea **${newChannel.name}** creata con successo sotto la categoria impostata! Svanirà quando usciranno tutti.` });
        } catch (e) {
            console.error('Errore creazione canale dello shop:', e);
            await interaction.editReply({ content: `❌ Errore durante la creazione della stanza. Assicurati che l'ID della categoria sia valido e che il bot abbia i permessi di Amministratore.` });
        }
    }
});

client.login(process.env.TOKEN);


