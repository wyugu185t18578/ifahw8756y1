const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
// You'll need to set this environment variable with your Firebase config
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersCollection = db.collection('users');

// Middleware
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
        sameSite: 'lax' // Helps with cookie issues
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

async function createUser(username, password) {
    const newUser = {
        username,
        password, // In production, hash this with bcrypt!
        createdAt: new Date().toISOString(),
        hwid: null,
        hwidLockedAt: null
    };
    
    const docRef = await usersCollection.add(newUser);
    return { id: docRef.id, ...newUser };
}

async function updateUser(userId, updates) {
    await usersCollection.doc(userId).update(updates);
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

        // Check HWID lock
        if (user.hwid && user.hwid !== hwid) {
            return res.status(403).json({
                success: false,
                message: 'Hardware mismatch. Contact administrator.'
            });
        }

        // Lock HWID if not already locked
        if (!user.hwid) {
            await updateUser(user.id, {
                hwid: hwid,
                hwidLockedAt: new Date().toISOString()
            });
        }

        return res.json({
            success: true,
            message: 'Login successful',
            username: user.username
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

// Check Session
app.get('/api/check-session', (req, res) => {
    if (req.session.userId) {
        return res.json({
            loggedIn: true,
            user: {
                id: req.session.userId,
                username: req.session.username
            }
        });
    }
    return res.json({ loggedIn: false });
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
                hwid: userData.hwid,
                hwidLockedAt: userData.hwidLockedAt,
                isLocked: !!userData.hwid
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

// Get user's subscription status
app.get('/api/subscription', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({
            success: false,
            message: 'Not logged in'
        });
    }
    
    try {
        const snapshot = await usersCollection.doc(req.session.userId).get();
        
        if (!snapshot.exists) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        const user = snapshot.data();
        
        res.json({
            success: true,
            subscription: user.subscription || null
        });
    } catch (error) {
        console.error('Get subscription error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error'
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
});
