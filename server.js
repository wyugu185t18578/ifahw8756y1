const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Try to use environment variable first
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
        console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT from environment variable');
        console.error('Please check your .env file or use a firebase-adminsdk.json file instead');
        process.exit(1);
    }
} else {
    // Fall back to file
    try {
        serviceAccount = require('./firebase-adminsdk.json');
        console.log('Using firebase-adminsdk.json file for credentials');
    } catch (e) {
        console.error('No Firebase credentials found!');
        console.error('Either set FIREBASE_SERVICE_ACCOUNT in .env or create firebase-adminsdk.json');
        process.exit(1);
    }
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersCollection = db.collection('users');

// IMPORTANT: Stripe webhook endpoint MUST come BEFORE body-parser middleware
// because it needs the raw body for signature verification
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Signature present:', !!sig);

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('✅ Signature verified');
        console.log('Event type:', event.type);
        console.log('Event ID:', event.id);
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        console.error('Make sure STRIPE_WEBHOOK_SECRET in .env matches Stripe Dashboard');
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
        console.log('Processing event:', event.type);
        
        switch (event.type) {
            case 'checkout.session.completed':
                console.log('Handling checkout.session.completed');
                await handleCheckoutSessionCompleted(event.data.object);
                break;
            
            case 'customer.subscription.updated':
                console.log('Handling customer.subscription.updated');
                await handleSubscriptionUpdated(event.data.object);
                break;
            
            case 'customer.subscription.deleted':
                console.log('Handling customer.subscription.deleted');
                await handleSubscriptionDeleted(event.data.object);
                break;
            
            case 'invoice.payment_succeeded':
                console.log('Handling invoice.payment_succeeded');
                await handlePaymentSucceeded(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                console.log('Handling invoice.payment_failed');
                await handlePaymentFailed(event.data.object);
                break;

            default:
                console.log(`Unhandled event type ${event.type}`);
        }

        console.log('✅ Event processed successfully');
        res.json({ received: true });
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        console.error('Stack:', error.stack);
        res.status(500).json({ error: 'Webhook handler failed' });
    }
});

// Middleware - comes AFTER webhook endpoint
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'cursed-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax'
    }
}));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions
async function getUserByUsername(username) {
    const snapshot = await usersCollection.where('username', '==', username).limit(1).get();
    if (snapshot.empty) return null;
    
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };
}

async function getUserById(userId) {
    const doc = await usersCollection.doc(userId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
}

async function createUser(username, password) {
    const now = new Date().toISOString();
    const newUser = {
        username,
        password, // In production, hash this with bcrypt!
        createdAt: now,
        lastLogin: now,
        hwid: null,
        hwidLockedAt: null,
        // Subscription/License tracking
        subscription: {
            status: 'inactive', // inactive, active, cancelled
            package: null, // monthly, lifetime
            stripeCustomerId: null,
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
            activatedAt: null,
            cancelledAt: null
        },
        // User statistics
        stats: {
            totalLogins: 1,
            lastLoginDate: now,
            accountAge: 0 // will be calculated dynamically
        }
    };
    
    const docRef = await usersCollection.add(newUser);
    return { id: docRef.id, ...newUser };
}

async function updateUser(userId, updates) {
    await usersCollection.doc(userId).update(updates);
}

// Middleware to check if user is authenticated
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }
    next();
}

// API Routes

// C++ Software Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password, hwid } = req.body;

    if (!username || !password || !hwid) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    try {
        const user = await getUserByUsername(username);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        if (user.password !== password) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Check if user has an active subscription/license
        if (!user.subscription || user.subscription.status !== 'active') {
            return res.status(403).json({
                success: false,
                message: 'No active license. Please purchase a subscription.'
            });
        }

        // Check HWID lock
        if (user.hwid && user.hwid !== hwid) {
            return res.status(403).json({
                success: false,
                message: 'Hardware mismatch. Contact administrator.'
            });
        }

        // Lock HWID if not already locked
        const updates = {};
        if (!user.hwid) {
            updates.hwid = hwid;
            updates.hwidLockedAt = new Date().toISOString();
        }

        // Update last login and stats
        updates.lastLogin = new Date().toISOString();
        updates['stats.totalLogins'] = admin.firestore.FieldValue.increment(1);
        updates['stats.lastLoginDate'] = new Date().toISOString();

        await updateUser(user.id, updates);

        return res.json({
            success: true,
            message: 'Login successful',
            username: user.username,
            subscription: {
                package: user.subscription.package,
                status: user.subscription.status
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Web Login Endpoint (for dashboard)
app.post('/api/web-login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Missing credentials'
        });
    }

    try {
        const user = await getUserByUsername(username);

        if (!user || user.password !== password) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        req.session.userId = user.id;
        req.session.username = user.username;

        // Update last login
        await updateUser(user.id, {
            lastLogin: new Date().toISOString(),
            'stats.lastLoginDate': new Date().toISOString()
        });

        // Force save session before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Login failed - session error'
                });
            }

            return res.json({
                success: true,
                message: 'Login successful'
            });
        });

    } catch (error) {
        console.error('Web login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Signup Endpoint
app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    if (username.length < 3) {
        return res.status(400).json({
            success: false,
            message: 'Username must be at least 3 characters'
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            success: false,
            message: 'Password must be at least 6 characters'
        });
    }

    try {
        const existingUser = await getUserByUsername(username);

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'Username already exists'
            });
        }

        const newUser = await createUser(username, password);

        // Auto-login after signup
        req.session.userId = newUser.id;
        req.session.username = newUser.username;

        // Force save session before responding
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Signup successful but login failed'
                });
            }

            return res.json({
                success: true,
                message: 'Account created successfully'
            });
        });

    } catch (error) {
        console.error('Signup error:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Check Session - Enhanced with user data
app.get('/api/check-session', async (req, res) => {
    if (req.session.userId) {
        try {
            const user = await getUserById(req.session.userId);
            if (user) {
                // Calculate account age in days
                const accountAge = Math.floor((new Date() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24));
                
                return res.json({
                    loggedIn: true,
                    username: user.username,
                    user: {
                        username: user.username,
                        createdAt: user.createdAt,
                        lastLogin: user.lastLogin,
                        stats: {
                            ...user.stats,
                            accountAge
                        },
                        subscription: user.subscription
                    }
                });
            }
        } catch (error) {
            console.error('Session check error:', error);
        }
    }
    return res.json({ loggedIn: false });
});

// Get User Stats (protected endpoint)
app.get('/api/user/stats', requireAuth, async (req, res) => {
    try {
        const user = await getUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const accountAge = Math.floor((new Date() - new Date(user.createdAt)) / (1000 * 60 * 60 * 24));

        res.json({
            success: true,
            stats: {
                accountCreated: user.createdAt,
                lastLogin: user.lastLogin,
                totalLogins: user.stats?.totalLogins || 1,
                accountAgeDays: accountAge,
                hwidLocked: !!user.hwid,
                hwidLockedAt: user.hwidLockedAt,
                subscription: user.subscription
            }
        });
    } catch (error) {
        console.error('Get stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                message: 'Logout failed'
            });
        }
        res.json({
            success: true,
            message: 'Logged out successfully'
        });
    });
});

// Get All Users (Admin)
app.get('/api/users', async (req, res) => {
    try {
        const snapshot = await usersCollection.orderBy('createdAt', 'desc').get();
        const users = [];

        snapshot.forEach(doc => {
            const userData = doc.data();
            users.push({
                id: doc.id,
                username: userData.username,
                createdAt: userData.createdAt,
                lastLogin: userData.lastLogin,
                hwid: userData.hwid,
                hwidLockedAt: userData.hwidLockedAt,
                isLocked: !!userData.hwid,
                subscription: userData.subscription,
                stats: userData.stats
            });
        });

        res.json(users);

    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Reset HWID (Admin)
app.post('/api/reset-hwid', async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(400).json({
            success: false,
            message: 'Username required'
        });
    }

    try {
        const user = await getUserByUsername(username);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!user.hwid) {
            return res.status(400).json({
                success: false,
                message: 'User is not hardware locked'
            });
        }

        await updateUser(user.id, {
            hwid: null,
            hwidLockedAt: null
        });

        res.json({
            success: true,
            message: `Hardware lock reset for ${username}`
        });

    } catch (error) {
        console.error('Reset HWID error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// ==================== STRIPE INTEGRATION ====================

// Get Stripe Config
app.get('/api/stripe/config', (req, res) => {
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Get available packages
app.get('/api/packages', (req, res) => {
    res.json({
        success: true,
        packages: [
            {
                id: 'monthly',
                name: 'Monthly',
                price: 19.99,
                priceId: process.env.STRIPE_PRICE_MONTHLY,
                features: [
                    'Full access to software',
                    'Hardware-locked license',
                    'Priority support',
                    'Monthly updates'
                ]
            },
            {
                id: 'lifetime',
                name: 'Lifetime',
                price: 99.99,
                priceId: process.env.STRIPE_PRICE_LIFETIME,
                features: [
                    'Lifetime access',
                    'Hardware-locked license',
                    'Priority support',
                    'All future updates',
                    'One-time payment'
                ]
            }
        ]
    });
});

// Create Stripe Checkout Session
app.post('/api/stripe/create-checkout-session', requireAuth, async (req, res) => {
    const { priceId, packageType } = req.body;

    if (!priceId || !packageType) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields'
        });
    }

    try {
        const user = await getUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Create or retrieve Stripe customer
        let customerId = user.subscription?.stripeCustomerId;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: `${user.username}@cursed.local`, // You might want to collect real emails
                metadata: {
                    userId: user.id,
                    username: user.username
                }
            });
            customerId = customer.id;
            
            // Save customer ID to user
            await updateUser(user.id, {
                'subscription.stripeCustomerId': customerId
            });
        }

        // Determine if this is a subscription or one-time payment
        const isLifetime = packageType === 'lifetime';

        const sessionConfig = {
            customer: customerId,
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: isLifetime ? 'payment' : 'subscription',
            success_url: `${req.headers.origin || 'http://localhost:3000'}/dashboard?success=true`,
            cancel_url: `${req.headers.origin || 'http://localhost:3000'}/dashboard?cancelled=true`,
            metadata: {
                userId: user.id,
                username: user.username,
                packageType: packageType
            }
        };

        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.json({
            success: true,
            url: session.url,
            sessionId: session.id
        });

    } catch (error) {
        console.error('Stripe session creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create checkout session'
        });
    }
});

// Webhook handler functions
async function handleCheckoutSessionCompleted(session) {
    console.log('=== CHECKOUT SESSION COMPLETED ===');
    console.log('Session ID:', session.id);
    console.log('Metadata:', session.metadata);
    
    const userId = session.metadata.userId;
    const packageType = session.metadata.packageType;
    
    if (!userId) {
        console.error('❌ No userId in metadata!');
        return;
    }

    console.log(`Processing for user ${userId}, package: ${packageType}`);
    
    const updates = {
        'subscription.status': 'active',
        'subscription.package': packageType,
        'subscription.activatedAt': new Date().toISOString(),
        'subscription.stripeCustomerId': session.customer
    };

    if (packageType === 'lifetime') {
        updates['subscription.currentPeriodEnd'] = null;
        console.log('Lifetime license - no expiration');
    } else {
        updates['subscription.stripeSubscriptionId'] = session.subscription;
        
        if (session.subscription) {
            try {
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                updates['subscription.currentPeriodEnd'] = new Date(subscription.current_period_end * 1000).toISOString();
                console.log('Monthly subscription - expires:', updates['subscription.currentPeriodEnd']);
            } catch (err) {
                console.error('Failed to retrieve subscription details:', err);
            }
        }
    }

    console.log('Updates to apply:', updates);

    try {
        await updateUser(userId, updates);
        console.log(`✅ License activated for user ${userId}`);
    } catch (error) {
        console.error('❌ Failed to update user:', error);
        throw error;
    }
}

async function handleSubscriptionUpdated(subscription) {
    const customerId = subscription.customer;
    
    // Find user by customer ID
    const snapshot = await usersCollection
        .where('subscription.stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
    
    if (snapshot.empty) {
        console.error('User not found for customer:', customerId);
        return;
    }

    const userId = snapshot.docs[0].id;
    
    const updates = {
        'subscription.status': subscription.status,
        'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000).toISOString()
    };

    await updateUser(userId, updates);
    console.log(`Subscription updated for user ${userId}`);
}

async function handleSubscriptionDeleted(subscription) {
    const customerId = subscription.customer;
    
    const snapshot = await usersCollection
        .where('subscription.stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
    
    if (snapshot.empty) {
        console.error('User not found for customer:', customerId);
        return;
    }

    const userId = snapshot.docs[0].id;
    
    await updateUser(userId, {
        'subscription.status': 'cancelled',
        'subscription.cancelledAt': new Date().toISOString()
    });
    
    console.log(`Subscription cancelled for user ${userId}`);
}

async function handlePaymentSucceeded(invoice) {
    console.log(`Payment succeeded for invoice ${invoice.id}`);
    // Additional logic if needed for successful payments
}

async function handlePaymentFailed(invoice) {
    console.log(`Payment failed for invoice ${invoice.id}`);
    
    const customerId = invoice.customer;
    const snapshot = await usersCollection
        .where('subscription.stripeCustomerId', '==', customerId)
        .limit(1)
        .get();
    
    if (!snapshot.empty) {
        const userId = snapshot.docs[0].id;
        // You might want to notify the user or take action here
        console.log(`Payment failed for user ${userId}`);
    }
}

// Get Subscription Status (for dashboard)
app.get('/api/subscription', requireAuth, async (req, res) => {
    try {
        const user = await getUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!user.subscription || user.subscription.status === 'inactive') {
            return res.json({
                success: true,
                subscription: null
            });
        }

        res.json({
            success: true,
            subscription: {
                status: user.subscription.status,
                package: user.subscription.package,
                activatedAt: user.subscription.activatedAt,
                currentPeriodEnd: user.subscription.currentPeriodEnd,
                cancelledAt: user.subscription.cancelledAt
            }
        });

    } catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});

// Cancel Subscription
app.post('/api/stripe/cancel-subscription', requireAuth, async (req, res) => {
    try {
        const user = await getUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        if (!user.subscription?.stripeSubscriptionId) {
            return res.status(400).json({
                success: false,
                message: 'No active subscription to cancel'
            });
        }

        // Cancel the subscription at period end
        const subscription = await stripe.subscriptions.update(
            user.subscription.stripeSubscriptionId,
            { cancel_at_period_end: true }
        );

        await updateUser(user.id, {
            'subscription.status': 'cancelled',
            'subscription.cancelledAt': new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Subscription cancelled. Access will continue until the end of the billing period.'
        });

    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cancel subscription'
        });
    }
});

// Route handlers
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Stripe integration: ${process.env.STRIPE_SECRET_KEY ? 'Enabled' : 'Disabled'}`);
});
