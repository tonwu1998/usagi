require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'reminders.json');

// Load or initialize reminders storage
function loadReminders() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveReminders(reminders) {
  fs.writeFileSync(DB_FILE, JSON.stringify(reminders, null, 2));
}

// Parse simple duration strings like "10m", "2h", "3d"
function parseDuration(input) {
  const match = input.trim().match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('m')) return value * 60 * 1000;
  if (unit.startsWith('h')) return value * 60 * 60 * 1000;
  if (unit.startsWith('d')) return value * 24 * 60 * 60 * 1000;
  return null;
}

// Define slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Schedule a server reminder with an optional push notification ping')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((opt) =>
      opt
        .setName('when')
        .setDescription('Delay (e.g., 10m, 2h, 3d) OR exact date (e.g., 2026-11-18 06:10)')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Reminder message').setRequired(true)
    )
    .addUserOption((opt) =>
      opt.setName('ping_user').setDescription('Specific user to ping for push notification').setRequired(false)
    )
    .addRoleOption((opt) =>
      opt.setName('ping_role').setDescription('Role to ping for push notification').setRequired(false)
    )
    .addChannelOption((opt) =>
      opt.setName('channel').setDescription('Target channel (defaults to current)').setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('repeat')
        .setDescription('Repeat interval')
        .addChoices(
          { name: 'None (One-time)', value: 'none' },
          { name: 'Daily', value: 'daily' },
          { name: 'Weekly', value: 'weekly' }
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List all active reminders in this server'),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel an active reminder by ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((opt) =>
      opt.setName('id').setDescription('The reminder ID from /reminders').setRequired(true)
    ),
].map((cmd) => cmd.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Register slash commands on startup
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.REMINDER_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.REMINDER_CLIENT_ID), { body: commands });
  console.log('Slash commands registered.');
}

// Background loop checking due reminders every 15 seconds
function startReminderLoop() {
  setInterval(async () => {
    const reminders = loadReminders();
    const now = Date.now();
    let changed = false;
    const remaining = [];

    for (const r of reminders) {
      if (r.triggerAt <= now) {
        changed = true;
        try {
          const channel = await client.channels.fetch(r.channelId);
          if (channel) {
            const embed = new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle('⏰ Reminder')
              .setDescription(r.message)
              .setTimestamp();

            // Mentions MUST be in `content` (outside the embed) to trigger push notifications
            const mentions = [
              r.roleId ? `<@&${r.roleId}>` : null,
              r.userId ? `<@${r.userId}>` : null,
            ]
              .filter(Boolean)
              .join(' ');

            await channel.send({
              content: mentions || null,
              embeds: [embed],
              allowedMentions: { parse: ['roles', 'users', 'everyone'] },
            });
          }
        } catch (err) {
          console.error(`Failed to send reminder ${r.id}:`, err);
        }

        // Reschedule if recurring
        if (r.repeat === 'daily') {
          r.triggerAt += 24 * 60 * 60 * 1000;
          remaining.push(r);
        } else if (r.repeat === 'weekly') {
          r.triggerAt += 7 * 24 * 60 * 60 * 1000;
          remaining.push(r);
        }
      } else {
        remaining.push(r);
      }
    }

    if (changed) saveReminders(remaining);
  }, 15_000);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  startReminderLoop();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'remind') {
    const whenInput = interaction.options.getString('when');
    const message = interaction.options.getString('message');
    const user = interaction.options.getUser('ping_user');
    const role = interaction.options.getRole('ping_role');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const repeat = interaction.options.getString('repeat') || 'none';

    let triggerAt = null;
    const durationMs = parseDuration(whenInput);

    if (durationMs) {
      triggerAt = Date.now() + durationMs;
    } else {
      const parsedDate = Date.parse(whenInput);
      if (!isNaN(parsedDate) && parsedDate > Date.now()) {
        triggerAt = parsedDate;
      }
    }

    if (!triggerAt) {
      return interaction.reply({
        content: 'Invalid time format. Use a delay like `30m`, `2h`, `5d` or a future date like `2026-11-18 06:10`.',
        ephemeral: true,
      });
    }

    const reminders = loadReminders();
    const id = Math.random().toString(36).substring(2, 8).toUpperCase();

    reminders.push({
      id,
      guildId: interaction.guildId,
      channelId: channel.id,
      roleId: role ? role.id : null,
      userId: user ? user.id : null,
      message,
      triggerAt,
      repeat,
    });
    saveReminders(reminders);

    const pingSummary = [
      user ? `**@${user.username}**` : null,
      role ? `**@${role.name}**` : null,
    ]
      .filter(Boolean)
      .join(' and ');

    const unix = Math.floor(triggerAt / 1000);
    await interaction.reply({
      content: `✅ Reminder **#${id}** scheduled for <t:${unix}:F> (<t:${unix}:R>) in <#${channel.id}>${
        pingSummary ? ` pinging ${pingSummary}` : ''
      } (Repeat: **${repeat}**).`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'reminders') {
    const reminders = loadReminders().filter((r) => r.guildId === interaction.guildId);
    if (reminders.length === 0) {
      return interaction.reply({ content: 'No active reminders in this server.', ephemeral: true });
    }

    const list = reminders
      .map((r) => {
        const unix = Math.floor(r.triggerAt / 1000);
        return `• **#${r.id}** — <t:${unix}:F> (${r.repeat}) in <#${r.channelId}>: "${r.message}"`;
      })
      .join('\n');

    await interaction.reply({ content: list, ephemeral: true });
  }

  if (interaction.commandName === 'cancel') {
    const id = interaction.options.getString('id').toUpperCase().replace('#', '');
    const reminders = loadReminders();
    const filtered = reminders.filter((r) => !(r.guildId === interaction.guildId && r.id === id));

    if (filtered.length === reminders.length) {
      return interaction.reply({ content: `Reminder **#${id}** not found.`, ephemeral: true });
    }

    saveReminders(filtered);
    await interaction.reply({ content: `🗑️ Cancelled reminder **#${id}**.`, ephemeral: true });
  }
});

client.login(process.env.REMINDER_TOKEN);