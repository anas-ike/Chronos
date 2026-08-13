const DiscordStrategy = require('passport-discord').Strategy;

module.exports = function(passport) {
    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    passport.use(new DiscordStrategy({
        clientID: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        callbackURL: `${process.env.DASHBOARD_URL}/auth/discord/callback`,
        scope: ['identify', 'guilds']
    }, (accessToken, refreshToken, profile, done) => {
        // Return the profile which includes the guilds array
        return done(null, profile);
    }));
};
