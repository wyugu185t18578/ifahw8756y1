const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersCollection = db.collection('users');
const vouchesCollection = db.collection('vouches'); // Add vouches collection

// ==================== DISCORD BOT ====================
// Start Discord bot in the same process
if (process.env.DISCORD_BOT_TOKEN) {
    require('./discord-bot');
    console.log('🤖 Discord bot started');
} else {
    console.log('⚠️ DISCORD_BOT_TOKEN not set - Discord bot disabled');
}

// ==================== STRIPE WEBHOOK (MUST BE BEFORE bodyParser) ====================
// This MUST be defined before app.use(bodyParser.json()) because Stripe needs raw body for signature verification
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    console.log('🔔 Webhook received!');

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('✅ Webhook signature verified');
    } catch (err) {
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
        console.log(`📩 Event type: ${event.type}`);
        
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object);
                break;
            
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;
            
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;
            
            case 'invoice.payment_succeeded':
                await handlePaymentSucceeded(event.data.object);
                break;
            
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;

            default:
                console.log(`ℹ️ Unhandled event type ${event.type}`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.status(500).json({ error: 'Webhook handler failed' });
    }
});

// Webhook handler functions
async function handleCheckoutSessionCompleted(session) {
    const userId = session.metadata.userId;
    const packageType = session.metadata.packageType;
    
    console.log(`🎉 Processing checkout for user ${userId}, package: ${packageType}`);
    console.log(`💳 Customer ID: ${session.customer}`);
    
    try {
        const updates = {
            'subscription.status': 'active',
            'subscription.package': packageType,
            'subscription.stripeCustomerId': session.customer,
            'subscription.activatedAt': admin.firestore.FieldValue.serverTimestamp()
        };

        if (packageType === 'lifetime') {
            // Lifetime purchase - no end date
            updates['subscription.currentPeriodEnd'] = null;
            console.log('📦 Type: Lifetime purchase');
        } else {
            // Monthly subscription
            updates['subscription.stripeSubscriptionId'] = session.subscription;
            
            // Get subscription details from Stripe to set the end date
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            updates['subscription.currentPeriodEnd'] = admin.firestore.Timestamp.fromDate(
                new Date(subscription.current_period_end * 1000)
            );
            console.log('📦 Type: Monthly subscription');
            console.log(`📅 Period ends: ${new Date(subscription.current_period_end * 1000).toISOString()}`);
        }

        await usersCollection.doc(userId).update(updates);
        console.log('✅ User subscription activated successfully');
        
    } catch (error) {
        console.error('❌ Error activating subscription:', error);
        throw error;
    }
}

async function handleSubscriptionUpdated(subscription) {
    console.log(`🔄 Subscription updated: ${subscription.id}`);
    
    try {
        // Find user by Stripe customer ID
        const querySnapshot = await usersCollection
            .where('subscription.stripeCustomerId', '==', subscription.customer)
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            console.log('⚠️ No user found for customer:', subscription.customer);
            return;
        }

        const userDoc = querySnapshot.docs[0];
        
        const updates = {
            'subscription.status': subscription.status,
            'subscription.currentPeriodEnd': admin.firestore.Timestamp.fromDate(
                new Date(subscription.current_period_end * 1000)
            )
        };

        await userDoc.ref.update(updates);
        console.log('✅ Subscription status updated');

    } catch (error) {
        console.error('❌ Error updating subscription:', error);
        throw error;
    }
}

async function handleSubscriptionDeleted(subscription) {
    console.log(`🗑️ Subscription deleted: ${subscription.id}`);
    
    try {
        const querySnapshot = await usersCollection
            .where('subscription.stripeCustomerId', '==', subscription.customer)
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            console.log('⚠️ No user found for customer:', subscription.customer);
            return;
        }

        const userDoc = querySnapshot.docs[0];
        
        await userDoc.ref.update({
            'subscription.status': 'cancelled',
            'subscription.cancelledAt': admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log('✅ Subscription marked as cancelled');

    } catch (error) {
        console.error('❌ Error cancelling subscription:', error);
        throw error;
    }
}

async function handlePaymentSucceeded(invoice) {
    console.log(`💰 Payment succeeded for invoice: ${invoice.id}`);
    
    if (invoice.subscription) {
        try {
            const querySnapshot = await usersCollection
                .where('subscription.stripeCustomerId', '==', invoice.customer)
                .limit(1)
                .get();

            if (!querySnapshot.empty) {
                const userDoc = querySnapshot.docs[0];
                
                await userDoc.ref.update({
                    'subscription.lastPaymentDate': admin.firestore.FieldValue.serverTimestamp(),
                    'subscription.lastPaymentAmount': invoice.amount_paid / 100
                });
                
                console.log('✅ Payment recorded');
            }
        } catch (error) {
            console.error('❌ Error recording payment:', error);
        }
    }
}

async function handlePaymentFailed(invoice) {
    console.log(`❌ Payment failed for invoice: ${invoice.id}`);
    
    if (invoice.subscription) {
        try {
            const querySnapshot = await usersCollection
                .where('subscription.stripeCustomerId', '==', invoice.customer)
                .limit(1)
                .get();

            if (!querySnapshot.empty) {
                const userDoc = querySnapshot.docs[0];
                
                await userDoc.ref.update({
                    'subscription.paymentFailed': true,
                    'subscription.lastPaymentError': invoice.last_payment_error?.message || 'Payment failed'
                });
                
                console.log('✅ Payment failure recorded');
            }
        } catch (error) {
            console.error('❌ Error recording payment failure:', error);
        }
    }
}

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ==================== VOUCH API ENDPOINTS ====================

// Get featured vouches for website display
app.get('/api/vouches/featured', async (req, res) => {
    try {
        const vouchesSnapshot = await vouchesCollection
            .where('approved', '==', true)
            .where('featured', '==', true)
            .orderBy('createdAt', 'desc')
            .limit(6)
            .get();

        const vouches = vouchesSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate().toISOString()
        }));

        res.json({ success: true, vouches });
    } catch (error) {
        console.error('Error fetching featured vouches:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch vouches' });
    }
});

// Get all approved vouches (paginated)
app.get('/api/vouches', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const lastId = req.query.lastId;

        let query = vouchesCollection
            .where('approved', '==', true)
            .orderBy('createdAt', 'desc')
            .limit(limit);

        if (lastId) {
            const lastDoc = await vouchesCollection.doc(lastId).get();
            if (lastDoc.exists) {
                query = query.startAfter(lastDoc);
            }
        }

        const vouchesSnapshot = await query.get();

        const vouches = vouchesSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate().toISOString()
        }));

        res.json({ 
            success: true, 
            vouches,
            hasMore: vouches.length === limit
        });
    } catch (error) {
        console.error('Error fetching vouches:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch vouches' });
    }
});

// Get vouch statistics
app.get('/api/vouches/stats', async (req, res) => {
    try {
        const vouchesSnapshot = await vouchesCollection
            .where('approved', '==', true)
            .get();

        const vouches = vouchesSnapshot.docs.map(doc => doc.data());
        const totalVouches = vouches.length;
        const averageRating = totalVouches > 0 
            ? (vouches.reduce((sum, v) => sum + v.rating, 0) / totalVouches).toFixed(1)
            : 0;

        const ratingDistribution = [1, 2, 3, 4, 5].map(rating => ({
            rating,
            count: vouches.filter(v => v.rating === rating).length
        }));

        res.json({ 
            success: true, 
            stats: {
                totalVouches,
                averageRating: parseFloat(averageRating),
                ratingDistribution
            }
        });
    } catch (error) {
        console.error('Error fetching vouch stats:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch statistics' });
    }
});

// ==================== EXISTING API ENDPOINTS ====================

// Check session endpoint
app.get('/api/check-session', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({ loggedIn: true, userId: req.session.userId });
    } else {
        res.json({ loggedIn: false });
    }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        // Query Firestore for user with matching username
        const querySnapshot = await usersCollection
            .where('username', '==', username)
            .limit(1)
            .get();

        if (querySnapshot.empty) {
            return res.json({ success: false, message: 'Invalid username or password' });
        }

        const userDoc = querySnapshot.docs[0];
        const userData = userDoc.data();

        // In production, use proper password hashing (bcrypt, etc.)
        if (userData.password !== password) {
            return res.json({ success: false, message: 'Invalid username or password' });
        }

        // Set session
        req.session.userId = userDoc.id;
        req.session.username = userData.username;

        res.json({ success: true, message: 'Login successful' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Signup endpoint
app.post('/api/signup', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        // Check if username already exists
        const usernameQuery = await usersCollection
            .where('username', '==', username)
            .limit(1)
            .get();

        if (!usernameQuery.empty) {
            return res.json({ success: false, message: 'Username already taken' });
        }

        // Check if email already exists
        const emailQuery = await usersCollection
            .where('email', '==', email)
            .limit(1)
            .get();

        if (!emailQuery.empty) {
            return res.json({ success: false, message: 'Email already registered' });
        }

        // Create new user
        const newUser = {
            username,
            email,
            password, // In production, hash this!
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            subscription: {
                status: 'none',
                package: null
            }
        };

        const userRef = await usersCollection.add(newUser);

        // Set session
        req.session.userId = userRef.id;
        req.session.username = username;

        res.json({ success: true, message: 'Account created successfully' });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout failed' });
        }
        res.json({ success: true, message: 'Logged out successfully' });
    });
});

// Get user info (for dashboard)
app.get('/api/user', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    try {
        const userDoc = await usersCollection.doc(req.session.userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userData = userDoc.data();
        
        // Don't send password to client
        delete userData.password;

        res.json({ success: true, user: userData });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Reset HWID endpoint
app.post('/api/reset-hwid', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    try {
        const userDoc = await usersCollection.doc(req.session.userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userData = userDoc.data();

        // Check if user has an active subscription
        if (!userData.subscription || userData.subscription.status !== 'active') {
            return res.json({ success: false, message: 'No active subscription' });
        }

        // Check last reset time (enforce 7-day cooldown)
        const lastReset = userData.subscription.lastHwidReset;
        if (lastReset) {
            const daysSinceReset = (Date.now() - lastReset.toDate()) / (1000 * 60 * 60 * 24);
            if (daysSinceReset < 7) {
                const daysRemaining = Math.ceil(7 - daysSinceReset);
                return res.json({ 
                    success: false, 
                    message: `HWID can only be reset once every 7 days. Please wait ${daysRemaining} more day(s).` 
                });
            }
        }

        // Reset HWID
        await usersCollection.doc(req.session.userId).update({
            'subscription.hwid': null,
            'subscription.lastHwidReset': admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'HWID reset successfully' });
    } catch (error) {
        console.error('HWID reset error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==================== STRIPE ENDPOINTS ====================

// Get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Get available packages
app.get('/api/packages', (req, res) => {
    const packages = [
        {
            id: 'trial',
            name: 'Trial',
            price: 5,
            priceId: process.env.STRIPE_PRICE_TRIAL,
            features: [
                'All features unlocked',
                'Trial only for 5$ / 3 days',
                'Access to Support',
                'Regular Updates'
            ]
        },
        {
            id: 'pro',
            name: 'Pro',
            price: 30,
            priceId: process.env.STRIPE_PRICE_PRO,
            features: [
                'All Features Unlocked',
                '30 Days of Access',
                'Priority Support',
                'Regular Updates'
            ]
        },
        {
            id: 'elite',
            name: 'Elite',
            price: 100,
            priceId: process.env.STRIPE_PRICE_ELITE,
            features: [
                'Everything in Pro',
                'Longer access for better price',
                '90 Days of Access',
                'Exclusive Features',
                'Early Access to Updates'
            ]
        },
        {
            id: 'lifetime',
            name: 'Lifetime',
            price: 300,
            priceId: process.env.STRIPE_PRICE_LIFETIME,
            features: [
                'Everything in Elite',
                'Lifetime Access',
                'No Recurring Payments',
                'VIP Support',
                'Exclusive Community Access'
            ]
        }
    ];

    res.json({ packages });
});

// Create Stripe checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const { priceId, packageType } = req.body;

    try {
        // Create or retrieve Stripe customer
        const userDoc = await usersCollection.doc(req.session.userId).get();
        const userData = userDoc.data();

        let customerId = userData.subscription?.stripeCustomerId;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email: userData.email,
                metadata: {
                    userId: req.session.userId,
                    username: userData.username
                }
            });
            customerId = customer.id;

            // Save customer ID
            await usersCollection.doc(req.session.userId).update({
                'subscription.stripeCustomerId': customerId
            });
        }

        // Determine if this is a subscription or one-time payment
        const isLifetime = packageType === 'lifetime';

        const sessionConfig = {
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1
            }],
            mode: isLifetime ? 'payment' : 'subscription',
            success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.headers.origin}/index.html`,
            metadata: {
                userId: req.session.userId,
                packageType: packageType
            }
        };

        const session = await stripe.checkout.sessions.create(sessionConfig);

        res.json({ success: true, url: session.url });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ success: false, message: 'Failed to create checkout session' });
    }
});

// Get subscription details
app.get('/api/subscription', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    try {
        const userDoc = await usersCollection.doc(req.session.userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userData = userDoc.data();
        const subscription = userData.subscription || { status: 'none' };

        res.json({ success: true, subscription });
    } catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Cancel subscription
app.post('/api/subscription/cancel', async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    try {
        const userDoc = await usersCollection.doc(req.session.userId).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const userData = userDoc.data();
        const subscriptionId = userData.subscription?.stripeSubscriptionId;

        if (!subscriptionId) {
            return res.json({ success: false, message: 'No active subscription found' });
        }

        // Cancel subscription at period end
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true
        });

        res.json({ success: true, message: 'Subscription will be cancelled at the end of the billing period' });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
    }
});

// ==================== SERVE HTML FILES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/signup.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/success.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});
