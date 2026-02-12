require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook endpoint (MUST be before express.json())
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.log(`⚠️  Webhook signature verification failed.`, err.message);
        return res.sendStatus(400);
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            const session = event.data.object;
            console.log('Payment successful!', session);
            
            // Update user subscription status
            const userId = session.metadata.userId;
            const packageType = session.metadata.packageType;
            
            const users = getUsers();
            const user = users.find(u => u.id === userId);
            
            if (user) {
                user.subscription = {
                    package: packageType,
                    status: 'active',
                    customerId: session.customer,
                    subscriptionId: session.subscription || null, // null for one-time payments
                    paymentIntentId: session.payment_intent || null,
                    mode: session.mode, // 'subscription' or 'payment'
                    createdAt: new Date().toISOString()
                };
                saveUsers(users);
                console.log(`✅ User ${user.username} purchased ${packageType} package`);
            }
            break;
            
        case 'customer.subscription.deleted':
            const subscription = event.data.object;
            console.log('Subscription cancelled!', subscription);
            
            // Update user subscription status
            const users2 = getUsers();
            const user2 = users2.find(u => u.subscription?.subscriptionId === subscription.id);
            
            if (user2) {
                user2.subscription.status = 'cancelled';
                user2.subscription.cancelledAt = new Date().toISOString();
                saveUsers(users2);
                console.log(`❌ User ${user2.username} subscription cancelled`);
            }
            break;
            
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'cursed-secret-key-change-this-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' // Use secure cookies in production
    }
}));

// File to store users (in production, use a real database)
const USERS_FILE = path.join(__dirname, 'users.json');

// Initialize users file if it doesn't exist
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([]));
}

// Helper functions
function getUsers() {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Check session endpoint
app.get('/api/check-session', (req, res) => {
    if (req.session.user) {
        res.json({
            loggedIn: true,
            user: req.session.user
        });
    } else {
        res.json({
            loggedIn: false
        });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.json({
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

// Web login endpoint (for login page)
app.post('/api/web-login', (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
        return res.json({
            success: false,
            message: 'Username and password are required'
        });
    }

    // Get existing users
    const users = getUsers();

    // Find user with matching username and password
    const user = users.find(
        u => u.username === username && u.password === password
    );

    if (!user) {
        return res.json({
            success: false,
            message: 'Invalid username or password'
        });
    }

    // Create session
    req.session.user = {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt
    };

    res.json({
        success: true,
        message: 'Login successful',
        user: req.session.user
    });
});

// Signup endpoint (for web interface)
app.post('/api/signup', (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
        return res.json({
            success: false,
            message: 'Username and password are required'
        });
    }

    if (username.length < 3) {
        return res.json({
            success: false,
            message: 'Username must be at least 3 characters'
        });
    }

    if (password.length < 6) {
        return res.json({
            success: false,
            message: 'Password must be at least 6 characters'
        });
    }

    // Get existing users
    const users = getUsers();

    // Check if username already exists (case-insensitive)
    const usernameExists = users.some(
        user => user.username.toLowerCase() === username.toLowerCase()
    );

    if (usernameExists) {
        return res.json({
            success: false,
            message: 'Username already taken'
        });
    }

    // Add new user
    const newUser = {
        id: Date.now().toString(),
        username: username,
        password: password, // In production, ALWAYS hash passwords!
        createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    // Auto-login after signup
    req.session.user = {
        id: newUser.id,
        username: newUser.username,
        createdAt: newUser.createdAt
    };

    res.json({
        success: true,
        message: 'Account created successfully!',
        user: req.session.user
    });
});

// Login endpoint (for C++ client with hardware ID locking)
app.post('/api/login', (req, res) => {
    const { username, password, hwid } = req.body;

    // Validation
    if (!username || !password) {
        return res.json({
            success: false,
            message: 'Username and password are required'
        });
    }

    // Get existing users
    const users = getUsers();

    // Find user with matching username and password
    const user = users.find(
        u => u.username === username && u.password === password
    );

    if (!user) {
        return res.json({
            success: false,
            message: 'Invalid username or password'
        });
    }

    // Hardware ID check (only for C++ client)
    if (hwid) {
        console.log('\n=== HWID CHECK ===');
        console.log('Received HWID from client:', hwid);
        console.log('HWID length:', hwid.length);
        console.log('Stored HWID in database:', user.hwid);
        console.log('Stored HWID length:', user.hwid ? user.hwid.length : 'N/A');
        
        // If user doesn't have a hardware ID yet, lock it to this one (first login from software)
        if (!user.hwid) {
            console.log('No HWID stored - locking account to this computer');
            user.hwid = hwid;
            user.hwidLockedAt = new Date().toISOString();
            saveUsers(users);
            
            return res.json({
                success: true,
                message: 'Login successful - Account locked to this computer',
                user: {
                    id: user.id,
                    username: user.username,
                    createdAt: user.createdAt
                }
            });
        }
        
        // If user has a hardware ID, verify it matches
        if (user.hwid !== hwid) {
            console.log('HWID MISMATCH!');
            console.log('Expected:', user.hwid);
            console.log('Got:     ', hwid);
            console.log('Character-by-character comparison:');
            for (let i = 0; i < Math.max(user.hwid.length, hwid.length); i++) {
                const stored = user.hwid[i] || '(end)';
                const received = hwid[i] || '(end)';
                const match = stored === received ? '✓' : '✗';
                console.log(`  [${i}] ${stored} vs ${received} ${match}`);
            }
            
            return res.json({
                success: false,
                message: 'Hardware ID mismatch - This account is locked to another computer'
            });
        }
        
        console.log('HWID match - login successful!');
    }

    // Successful login
    res.json({
        success: true,
        message: 'Login successful',
        user: {
            id: user.id,
            username: user.username,
            createdAt: user.createdAt
        }
    });
});

// Check username availability endpoint (optional - for real-time checking)
app.get('/api/check-username/:username', (req, res) => {
    const { username } = req.params;
    const users = getUsers();
    
    const exists = users.some(
        user => user.username.toLowerCase() === username.toLowerCase()
    );

    res.json({
        available: !exists
    });
});

// Get all users endpoint (for testing - remove in production!)
app.get('/api/users', (req, res) => {
    const users = getUsers();
    // Don't send passwords in production!
    const safeUsers = users.map(({ id, username, createdAt, hwid, hwidLockedAt }) => ({
        id,
        username,
        createdAt,
        hwid: hwid ? hwid.substring(0, 16) + '...' : null,
        hwidLockedAt,
        isLocked: !!hwid
    }));
    res.json(safeUsers);
});

// Reset hardware ID for a user (admin endpoint - protect this in production!)
app.post('/api/reset-hwid', (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.json({
            success: false,
            message: 'Username is required'
        });
    }
    
    const users = getUsers();
    const user = users.find(u => u.username === username);
    
    if (!user) {
        return res.json({
            success: false,
            message: 'User not found'
        });
    }
    
    if (!user.hwid) {
        return res.json({
            success: false,
            message: 'Account is not locked to any hardware'
        });
    }
    
    // Remove hardware ID lock
    delete user.hwid;
    delete user.hwidLockedAt;
    saveUsers(users);
    
    res.json({
        success: true,
        message: 'Hardware ID lock removed successfully'
    });
});

// Test endpoint to check HWID from client
app.post('/api/test-hwid', (req, res) => {
    const { hwid } = req.body;
    
    console.log('\n=== HWID TEST ===');
    console.log('Received HWID:', hwid);
    console.log('HWID length:', hwid ? hwid.length : 'N/A');
    console.log('HWID type:', typeof hwid);
    console.log('HWID (hex dump):', hwid ? Buffer.from(hwid).toString('hex') : 'N/A');
    
    res.json({
        success: true,
        received: hwid,
        length: hwid ? hwid.length : 0,
        type: typeof hwid
    });
});

// Get Stripe publishable key
app.get('/api/stripe/config', (req, res) => {
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Get package pricing info
app.get('/api/packages', (req, res) => {
    res.json({
        packages: [
            {
                id: 'monthly',
                name: 'Monthly Subscription',
                price: 20.00,
                priceId: process.env.STRIPE_PRICE_MONTHLY,
                billing: 'monthly',
                features: [
                    'Hardware-locked authentication',
                    'Single device license',
                    'Email support',
                    'Regular updates'
                ]
            },
            {
                id: 'lifetime',
                name: 'Lifetime Subscription',
                price: 149.00,
                priceId: process.env.STRIPE_PRICE_LIFETIME,
                billing: 'one-time',
                features: [
                    'Everything in Monthly',
                    'Dedicated account manager',
                    'Instant HWID reset access',
                    'Beta access to new features',
                    'Lifetime updates'
                ]
            }
        ]
    });
});

// Create Stripe checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
    const { priceId, packageType } = req.body;
    
    if (!req.session.user) {
        return res.json({
            success: false,
            message: 'You must be logged in to purchase'
        });
    }
    
    try {
        // Determine if this is a subscription or one-time payment
        const mode = packageType === 'lifetime' ? 'payment' : 'subscription';
        
        const sessionConfig = {
            mode: mode,
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            success_url: `${req.headers.origin}/dashboard.html?success=true`,
            cancel_url: `${req.headers.origin}/?cancelled=true`,
            customer_email: req.session.user.username + '@cursed.local',
            metadata: {
                userId: req.session.user.id,
                username: req.session.user.username,
                packageType: packageType
            }
        };
        
        const session = await stripe.checkout.sessions.create(sessionConfig);
        
        res.json({
            success: true,
            sessionId: session.id,
            url: session.url
        });
    } catch (error) {
        console.error('Stripe error:', error);
        res.json({
            success: false,
            message: 'Failed to create checkout session'
        });
    }
});

// Get user's subscription status
app.get('/api/subscription', (req, res) => {
    if (!req.session.user) {
        return res.json({
            success: false,
            message: 'Not logged in'
        });
    }
    
    const users = getUsers();
    const user = users.find(u => u.id === req.session.user.id);
    
    if (!user) {
        return res.json({
            success: false,
            message: 'User not found'
        });
    }
    
    res.json({
        success: true,
        subscription: user.subscription || null
    });
});

// Cancel subscription
app.post('/api/stripe/cancel-subscription', async (req, res) => {
    if (!req.session.user) {
        return res.json({
            success: false,
            message: 'Not logged in'
        });
    }
    
    const users = getUsers();
    const user = users.find(u => u.id === req.session.user.id);
    
    if (!user || !user.subscription) {
        return res.json({
            success: false,
            message: 'No active subscription found'
        });
    }
    
    // Can't cancel one-time payments (lifetime)
    if (user.subscription.mode === 'payment' || user.subscription.package === 'lifetime') {
        return res.json({
            success: false,
            message: 'Lifetime subscriptions cannot be cancelled. This is a one-time payment.'
        });
    }
    
    if (!user.subscription.subscriptionId) {
        return res.json({
            success: false,
            message: 'No subscription ID found'
        });
    }
    
    try {
        await stripe.subscriptions.cancel(user.subscription.subscriptionId);
        
        res.json({
            success: true,
            message: 'Subscription cancelled successfully'
        });
    } catch (error) {
        console.error('Stripe cancel error:', error);
        res.json({
            success: false,
            message: 'Failed to cancel subscription'
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Web signup: http://localhost:${PORT}/signup.html`);
    console.log('Press Ctrl+C to stop');
});