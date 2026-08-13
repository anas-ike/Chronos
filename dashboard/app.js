const express = require('express');
const session = require('express-session');
const passport = require('passport');
const path = require('path');
const logger = require('../src/helpers/logger');

const app = express();

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Expose the snapshots folder to the web
app.use('/snapshots', express.static(path.join(__dirname, '..', 'storage', 'snapshots'))); 

// Sessions
app.use(session({
    secret: process.env.ENCRYPTION_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 week
}));

// Passport Integration
require('./auth/passport')(passport);
app.use(passport.initialize());
app.use(passport.session());

// Routes
app.use('/', require('./routes/webRoutes'));
app.use('/auth', require('./routes/authRoutes'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Dashboard running at ${process.env.DASHBOARD_URL} on port ${PORT}`, 'Dashboard');
});

module.exports = app;
