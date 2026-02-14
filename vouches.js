const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');

// Get existing Firebase app instance (already initialized in server.js)
const db = admin.firestore();
const vouchesCollection = db.collection('vouches');

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Bot configuration
const PREFIX = '!';
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || null;

client.once('ready', () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);
    console.log(`📝 Vouch command: ${PREFIX}vouch @user [rating] [message]`);
    
    // Set bot status
    client.user.setActivity('for vouches', { type: 3 }); // Type 3 = WATCHING
});

client.on('messageCreate', async (message) => {
    // Ignore bot messages and messages not starting with prefix
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // !vouch command
    if (command === 'vouch') {
        // Check if in designated vouch channel (if set)
        if (VOUCH_CHANNEL_ID && message.channel.id !== VOUCH_CHANNEL_ID) {
            return message.reply(`⚠️ Please use vouches in <#${VOUCH_CHANNEL_ID}>`);
        }

        // Parse arguments: @user rating message
        const mentionedUser = message.mentions.users.first();
        
        if (!mentionedUser) {
            return message.reply('❌ Please mention a user to vouch for. Usage: `!vouch @user 5 Great experience!`');
        }

        if (mentionedUser.id === message.author.id) {
            return message.reply('❌ You cannot vouch for yourself!');
        }

        // Get rating (should be 1-5)
        const ratingArg = args[1];
        const rating = parseInt(ratingArg);
        
        if (!ratingArg || isNaN(rating) || rating < 1 || rating > 5) {
            return message.reply('❌ Please provide a valid rating (1-5). Usage: `!vouch @user 5 Great experience!`');
        }

        // Get the vouch message (everything after rating)
        const vouchMessage = args.slice(2).join(' ');
        
        if (!vouchMessage || vouchMessage.length < 10) {
            return message.reply('❌ Please provide a vouch message (at least 10 characters). Usage: `!vouch @user 5 Great experience!`');
        }

        if (vouchMessage.length > 500) {
            return message.reply('❌ Vouch message is too long (max 500 characters).');
        }

        try {
            // Save vouch to Firestore
            const vouchData = {
                authorId: message.author.id,
                authorUsername: message.author.username,
                authorDiscriminator: message.author.discriminator,
                authorAvatar: message.author.displayAvatarURL(),
                targetUserId: mentionedUser.id,
                targetUsername: mentionedUser.username,
                rating: rating,
                message: vouchMessage,
                serverId: message.guild.id,
                serverName: message.guild.name,
                channelId: message.channel.id,
                messageId: message.id,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                approved: false,
                featured: false,
            };

            const vouchRef = await vouchesCollection.add(vouchData);

            // Create embed response
            const embed = new EmbedBuilder()
                .setColor('#b4bace')
                .setTitle('✅ Vouch Submitted')
                .setDescription(`Your vouch for **${mentionedUser.username}** has been submitted and is pending approval.`)
                .addFields(
                    { name: 'Rating', value: '⭐'.repeat(rating), inline: true },
                    { name: 'Message', value: vouchMessage, inline: false }
                )
                .setFooter({ text: `Vouch ID: ${vouchRef.id}` })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

            // Notify admins/moderators if there's a log channel
            const logChannelId = process.env.VOUCH_LOG_CHANNEL_ID;
            if (logChannelId) {
                try {
                    const logChannel = await client.channels.fetch(logChannelId);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setColor('#ffa500')
                            .setTitle('🔔 New Vouch Pending Approval')
                            .setDescription(`**${message.author.tag}** vouched for **${mentionedUser.tag}**`)
                            .addFields(
                                { name: 'Rating', value: '⭐'.repeat(rating), inline: true },
                                { name: 'Message', value: vouchMessage, inline: false },
                                { name: 'Approve', value: `\`!approve ${vouchRef.id}\``, inline: true },
                                { name: 'Reject', value: `\`!reject ${vouchRef.id}\``, inline: true }
                            )
                            .setFooter({ text: `Vouch ID: ${vouchRef.id}` })
                            .setTimestamp();

                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } catch (error) {
                    console.error('Failed to send log channel notification:', error);
                }
            }

        } catch (error) {
            console.error('Error saving vouch:', error);
            await message.reply('❌ Failed to submit vouch. Please try again later.');
        }
    }

    // !approve command (admin only)
    if (command === 'approve') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ You do not have permission to approve vouches.');
        }

        const vouchId = args[0];
        if (!vouchId) {
            return message.reply('❌ Please provide a vouch ID. Usage: `!approve <vouchId>`');
        }

        try {
            const vouchRef = vouchesCollection.doc(vouchId);
            const vouchDoc = await vouchRef.get();

            if (!vouchDoc.exists) {
                return message.reply('❌ Vouch not found.');
            }

            await vouchRef.update({
                approved: true,
                approvedBy: message.author.id,
                approvedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('✅ Vouch Approved')
                .setDescription(`Vouch ID: ${vouchId} has been approved.`)
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error approving vouch:', error);
            await message.reply('❌ Failed to approve vouch.');
        }
    }

    // !reject command (admin only)
    if (command === 'reject') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ You do not have permission to reject vouches.');
        }

        const vouchId = args[0];
        if (!vouchId) {
            return message.reply('❌ Please provide a vouch ID. Usage: `!reject <vouchId>`');
        }

        const reason = args.slice(1).join(' ') || 'No reason provided';

        try {
            const vouchRef = vouchesCollection.doc(vouchId);
            const vouchDoc = await vouchRef.get();

            if (!vouchDoc.exists) {
                return message.reply('❌ Vouch not found.');
            }

            await vouchRef.update({
                approved: false,
                rejected: true,
                rejectedBy: message.author.id,
                rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
                rejectionReason: reason
            });

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('❌ Vouch Rejected')
                .setDescription(`Vouch ID: ${vouchId} has been rejected.`)
                .addFields({ name: 'Reason', value: reason })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error rejecting vouch:', error);
            await message.reply('❌ Failed to reject vouch.');
        }
    }

    // !feature command (admin only)
    if (command === 'feature') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return message.reply('❌ You do not have permission to feature vouches.');
        }

        const vouchId = args[0];
        if (!vouchId) {
            return message.reply('❌ Please provide a vouch ID. Usage: `!feature <vouchId>`');
        }

        try {
            const vouchRef = vouchesCollection.doc(vouchId);
            const vouchDoc = await vouchRef.get();

            if (!vouchDoc.exists) {
                return message.reply('❌ Vouch not found.');
            }

            const vouchData = vouchDoc.data();
            
            if (!vouchData.approved) {
                return message.reply('❌ Vouch must be approved before it can be featured.');
            }

            const newFeaturedState = !vouchData.featured;

            await vouchRef.update({
                featured: newFeaturedState
            });

            const embed = new EmbedBuilder()
                .setColor(newFeaturedState ? '#00ff00' : '#ff9900')
                .setTitle(newFeaturedState ? '⭐ Vouch Featured' : '📌 Vouch Unfeatured')
                .setDescription(`Vouch ID: ${vouchId} is ${newFeaturedState ? 'now featured' : 'no longer featured'} on the website.`)
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error featuring vouch:', error);
            await message.reply('❌ Failed to feature vouch.');
        }
    }

    // !vouches command
    if (command === 'vouches') {
        const mentionedUser = message.mentions.users.first() || message.author;

        try {
            const vouchesSnapshot = await vouchesCollection
                .where('targetUserId', '==', mentionedUser.id)
                .where('approved', '==', true)
                .get();

            if (vouchesSnapshot.empty) {
                return message.reply(`${mentionedUser.username} has no approved vouches yet.`);
            }

            const vouches = vouchesSnapshot.docs.map(doc => doc.data());
            const totalVouches = vouches.length;
            const averageRating = (vouches.reduce((sum, v) => sum + v.rating, 0) / totalVouches).toFixed(1);
            
            const ratingDistribution = [1, 2, 3, 4, 5].map(rating => {
                const count = vouches.filter(v => v.rating === rating).length;
                return `${'⭐'.repeat(rating)}: ${count}`;
            }).join('\n');

            const embed = new EmbedBuilder()
                .setColor('#b4bace')
                .setTitle(`📊 Vouch Statistics for ${mentionedUser.username}`)
                .setThumbnail(mentionedUser.displayAvatarURL())
                .addFields(
                    { name: 'Total Vouches', value: totalVouches.toString(), inline: true },
                    { name: 'Average Rating', value: `${averageRating} ⭐`, inline: true },
                    { name: 'Rating Distribution', value: ratingDistribution, inline: false }
                )
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error fetching vouches:', error);
            await message.reply('❌ Failed to fetch vouches.');
        }
    }

    // !help command
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#b4bace')
            .setTitle('📝 CURSED Vouch Bot Commands')
            .setDescription('Here are all available commands:')
            .addFields(
                { 
                    name: '`!vouch @user [rating] [message]`', 
                    value: 'Submit a vouch for a user (rating 1-5)', 
                    inline: false 
                },
                { 
                    name: '`!vouches [@user]`', 
                    value: 'View vouch statistics for yourself or another user', 
                    inline: false 
                },
                { 
                    name: '`!approve <vouchId>`', 
                    value: 'Approve a pending vouch (Admin only)', 
                    inline: false 
                },
                { 
                    name: '`!reject <vouchId> [reason]`', 
                    value: 'Reject a vouch (Admin only)', 
                    inline: false 
                },
                { 
                    name: '`!feature <vouchId>`', 
                    value: 'Toggle featuring a vouch on the website (Admin only)', 
                    inline: false 
                },
                { 
                    name: '`!help`', 
                    value: 'Show this help message', 
                    inline: false 
                }
            )
            .setFooter({ text: 'CURSED - Premium Software Solution' })
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error('Failed to login to Discord:', error);
    console.log('Please check your DISCORD_BOT_TOKEN in environment variables');
});

module.exports = client;
