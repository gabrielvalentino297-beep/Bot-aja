try {
    const ffmpegStatic = require('ffmpeg-static');
    process.env.PATH = `${require('path').dirname(ffmpegStatic)}:${process.env.PATH}`;
    process.env.FFMPEG_PATH = ffmpegStatic;
    console.log('[FFMPEG] ✅ Path set:', ffmpegStatic);
} catch (e) {
    console.warn('[FFMPEG] ⚠️ ffmpeg-static tidak ditemukan:', e.message);
}

const { Client, GatewayIntentBits, Partials, Collection, ActivityType } = require('discord.js');
const { readdirSync } = require('fs');
const def = require('./defines');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message],
});

client.prefixcommands = new Collection();
client.aliases = new Collection();

for (const dir of readdirSync('./src/commands/prefix/')) {
    for (const file of readdirSync(`./src/commands/prefix/${dir}`).filter(f => f.endsWith('.js'))) {
        const cmd = require(`./src/commands/prefix/${dir}/${file}`);
        if (!cmd?.structure?.name || !cmd?.run) continue;
        client.prefixcommands.set(cmd.structure.name, cmd);
        if (cmd.structure.aliases) {
            cmd.structure.aliases.forEach(alias => client.aliases.set(alias, cmd.structure.name));
        }
        console.log(`[CMD] Loaded: ${file}`);
    }
}

const cooldown = new Map();
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(def.handler.prefix)) return;

    const args = message.content.slice(def.handler.prefix.length).trim().split(/ +/g);
    const commandInput = args.shift().toLowerCase();
    if (!commandInput.length) return;

    const command = client.prefixcommands.get(commandInput) || client.prefixcommands.get(client.aliases.get(commandInput));
    if (!command) return;

    try {
        if (command.structure?.cooldown) {
            const key = `${message.author.id}-${commandInput}`;
            if (cooldown.has(key)) {
                const remaining = ((cooldown.get(key) - Date.now()) / 1000).toFixed(1);
                return message.reply({ content: `Pelan-pelan! Cooldown ${remaining}s lagi.` });
            }
            cooldown.set(key, Date.now() + command.structure.cooldown);
            setTimeout(() => cooldown.delete(key), command.structure.cooldown);
        }
        command.run(client, message, args);
    } catch (error) {
        console.error('[CMD ERROR]', error);
    }
});

client.once('ready', () => {
    console.log(`[BOT] ✅ Logged in as ${client.user.tag}`);
    client.user.setPresence({
        activities: [{ name: def.servers.name, type: ActivityType.Watching }],
        status: 'online',
    });
});

client.login(def.client.token);

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);
