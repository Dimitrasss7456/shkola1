import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";

// Check if we're in a Replit environment
const isReplitEnvironment = process.env.REPL_ID && process.env.REPL_ID.trim() !== "";

if (!process.env.REPLIT_DOMAINS) {
  process.env.REPLIT_DOMAINS = "replit.app,replit.dev,replit.com";
}

const getOidcConfig = memoize(
  async () => {
    if (!isReplitEnvironment) {
      throw new Error("Not in Replit environment");
    }
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  { maxAge: 3600 * 1000 }
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET || 'package-management-secret-key',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      maxAge: sessionTtl,
    },
  });
}

function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

async function upsertUser(
  claims: any,
) {
  await storage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // Only setup OpenID if we're in a Replit environment
  if (isReplitEnvironment) {
    try {
      const config = await getOidcConfig();

      const verify: VerifyFunction = async (
        tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
        verified: passport.AuthenticateCallback
      ) => {
        const user = {};
        updateUserSession(user, tokens);
        await upsertUser(tokens.claims());
        verified(null, user);
      };

      for (const domain of process.env
        .REPLIT_DOMAINS!.split(",")) {
        const strategy = new Strategy(
          {
            name: `replitauth:${domain}`,
            config,
            scope: "openid email profile offline_access",
            callbackURL: `https://${domain}/api/callback`,
          },
          verify,
        );
        passport.use(strategy);
      }
    } catch (error) {
      console.log("OpenID setup failed, using demo login only:", error.message);
    }
  } else {
    console.log("Not in Replit environment, using demo login only");
  }

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  // Demo login endpoint for testing (POST)
  app.post("/api/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ message: "Email и пароль обязательны" });
      }

      const user = await storage.validateCredentials(email, password);
      
      if (!user) {
        return res.status(401).json({ message: "Неверный email или пароль" });
      }

      // Store user in session
      (req.session as any).user = user;
      
      res.json({ 
        user,
        message: "Успешный вход в систему"
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ message: "Ошибка входа в систему" });
    }
  });

  // Replit OAuth login (GET) - only if in Replit environment
  if (isReplitEnvironment) {
    app.get("/api/login", (req, res, next) => {
      passport.authenticate(`replitauth:${req.hostname}`, {
        prompt: "login consent",
        scope: ["openid", "email", "profile", "offline_access"],
      })(req, res, next);
    });

    app.get("/api/callback", (req, res, next) => {
      passport.authenticate(`replitauth:${req.hostname}`, {
        successReturnToOrRedirect: "/",
        failureRedirect: "/api/login",
      })(req, res, next);
    });
  }

  // Demo logout endpoint for testing (POST)
  app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Ошибка выхода из системы" });
      }
      res.json({ message: "Успешный выход из системы" });
    });
  });

  // Replit OAuth logout (GET) - only if in Replit environment
  if (isReplitEnvironment) {
    app.get("/api/logout", async (req, res) => {
      try {
        const config = await getOidcConfig();
        req.logout(() => {
          res.redirect(
            client.buildEndSessionUrl(config, {
              client_id: process.env.REPL_ID!,
              post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
            }).href
          );
        });
      } catch (error) {
        // Fallback to simple logout if OpenID fails
        req.session.destroy((err) => {
          if (err) {
            return res.status(500).json({ message: "Ошибка выхода из системы" });
          }
          res.redirect("/");
        });
      }
    });
  }

  // Get current user endpoint
  app.get('/api/auth/user', (req, res) => {
    // Check for demo login session first
    const sessionUser = (req.session as any)?.user;
    if (sessionUser) {
      return res.json(sessionUser);
    }
    
    // Otherwise, use Replit auth
    const user = req.user as any;
    if (req.isAuthenticated() && user) {
      res.json(user);
    } else {
      res.status(401).json({ message: "Unauthorized" });
    }
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  // Check for demo login session first
  const sessionUser = (req.session as any)?.user;
  if (sessionUser) {
    (req as any).user = sessionUser;
    return next();
  }

  // If not in Replit environment, only demo login is available
  if (!isReplitEnvironment) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Otherwise, use Replit auth
  const user = req.user as any;

  if (!req.isAuthenticated() || !user.expires_at) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};
