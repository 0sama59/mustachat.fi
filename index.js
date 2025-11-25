const express = require('express');
const { WebSocketServer } = require('wss');
const path = require('path');
const fs = require('fs'); 

const app = express();
// FIX: Use process.env.PORT for Render deployment
const PORT = process.env.PORT || 3000;
const BANS_FILE = 'bans.json'; 

// Serve static files (like index.html, script.js, style.css) from the 'public' directory
app.use(express.static(path.join(__dirname, 'public'))); 

// Start the HTTP server
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`)); // Changed log message

// Initialize WebSocket Server on the same HTTP server
const wsss = new WebSocketServer({ server });
const clients = new Map(); // Maps WebSocket connections to nicknames
const mutedUsers = new Set(); // Stores lowercase nicknames of currently muted users
let bannedUsers = new Map(); // Stores banned nicknames and their unban time
let isChatFrozen = false; // Tracks if the chat is frozen globally

// List of prohibited words for auto-banning
const badWords = ["stupid","idiot","dumb","fuck","bitch","motherfucker","mf","dick","pussy","nigger"];

// --- PERSISTENCE FUNCTIONS (Handles reading/writing bans.json) ---

// Loads active bans from bans.json upon server startup
function loadBans() {
    try {
        if (fs.existsSync(BANS_FILE)) {
            const data = fs.readFileSync(BANS_FILE, 'utf8');
            const bansArray = JSON.parse(data);
            
            const now = Date.now();
            bansArray.forEach(([nick, unbanTime]) => {
                // Only load bans that have not yet expired
                if (unbanTime > now) {
                    bannedUsers.set(nick, new Date(unbanTime));
                }
            });
            console.log(`Loaded ${bannedUsers.size} active bans from ${BANS_FILE}.`);
        }
    } catch (e) {
        console.error(`Error loading bans: ${e.message}`);
    }
}

// Saves the current list of active bans to bans.json
function saveBans() {
    try {
        const bansArray = Array.from(bannedUsers.entries()).map(([nick, unbanDate]) => 
            [nick, unbanDate.getTime()]
        );
        fs.writeFileSync(BANS_FILE, JSON.stringify(bansArray, null, 2), 'utf8');
    } catch (e) {
        console.error(`Error saving bans: ${e.message}`);
    }
}

// Checks if a nickname is currently banned
function isBanned(nick) {
    const banTime = bannedUsers.get(nick);
    if (!banTime) return false;

    // Check if ban has expired
    if (banTime.getTime() > Date.now()) {
        return true; 
    } else {
        // Ban expired, remove it and save
        bannedUsers.delete(nick); 
        saveBans(); 
        return false;
    }
}

loadBans();


// --- CORE CHAT FUNCTIONS ---

// Broadcasts the list of current users to all clients
function broadcastUsers() {
    const activeUsers = Array.from(clients.values()).filter(Boolean); 
    const data = JSON.stringify({ type: "users", users: activeUsers });
    wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(data); });
}

// Broadcasts a chat message to all clients
function broadcastChat(nick, text) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const data = JSON.stringify({ type: "chat", nick, text, timestamp });
    wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(data); });
}

// Sends a direct action (ban/kick) message to a specific user
function sendAction(targetName, type, minutes) {
    if (type === "ban") {
        // Set persistent ban record
        const unbanTime = Date.now() + (minutes * 60 * 1000);
        bannedUsers.set(targetName, new Date(unbanTime));
        saveBans(); 
    }

    for (let [wss, nick] of clients.entries()) {
        if (nick === targetName && wss.readyState === wss.OPEN) {
            wss.send(JSON.stringify({ type, minutes }));
            return true;
        }
    }
    return false;
}

// --- WEBSOCKET CONNECTION AND MESSAGE HANDLING ---

wsss.on('connection', wss => {
    clients.set(wss, null); 
    broadcastUsers();

    wss.on('message', message => {
        let data;
        try { data = JSON.parse(message.toString()); } catch(e){ return; }

        // --- NICKNAME SETUP ---
        if (data.type === "nick") {
            const newNick = data.nick;
            const isTaken = Array.from(clients.values()).includes(newNick);
            
            // 1. Ban Check
            if (isBanned(newNick)) {
                const banTime = bannedUsers.get(newNick);
                const remainingMinutes = Math.ceil((banTime - Date.now()) / (60 * 1000));
                wss.send(JSON.stringify({ type: "error", message: `You are banned for ${remainingMinutes} more minutes.` }));
                return;
            }

            // 2. Already Taken Check
            if (isTaken && newNick !== clients.get(wss)) {
                wss.send(JSON.stringify({ type: "error", message: `Nickname '${newNick}' is already taken!` }));
                return;
            }

            const oldNick = clients.get(wss);
            clients.set(wss, newNick);
            broadcastUsers();
            if (oldNick === null) {
                broadcastChat("SYSTEM", `${newNick} has joined the chat.`);
            }
            return;
        }

        // --- CHAT MESSAGES ---
        if (data.type === "chat") {
            const { nick, text } = data;
            const lowerNick = nick.toLowerCase();
            
            // 1. Ban Check (for mid-session messages)
            if (isBanned(nick)) {
                const banTime = bannedUsers.get(nick);
                const remainingMinutes = Math.ceil((banTime - Date.now()) / (60 * 1000));
                const wssInstance = Array.from(clients.entries()).find(([w, n]) => n === nick)?.[0];
                if (wssInstance) {
                    wssInstance.send(JSON.stringify({ type: "chat", nick: "SYSTEM", text: `You are banned for ${remainingMinutes} more minutes.` }));
                }
                return;
            }

            // 2. Mute Check
            if (mutedUsers.has(lowerNick)) {
                const wssInstance = Array.from(clients.entries()).find(([w, n]) => n === nick)?.[0];
                if (wssInstance) {
                    wssInstance.send(JSON.stringify({ type: "chat", nick: "SYSTEM", text: "You are currently muted and cannot send messages." }));
                }
                return;
            }
            
            // 3. FREEZE CHECK (Blocks all non-admin users)
            if (isChatFrozen && lowerNick !== "nimda") {
                const wssInstance = Array.from(clients.entries()).find(([w, n]) => n === nick)?.[0];
                if (wssInstance) {
                    wssInstance.send(JSON.stringify({ type: "chat", nick: "SYSTEM", text: "The chat is currently frozen by the Administrator. Your message was not sent." }));
                }
                return;
            }

            // 4. Auto-ban check for bad words
            if (badWords.some(bw => text.toLowerCase().includes(bw))) {
                sendAction(nick, "ban", 35);
                broadcastChat("SYSTEM", `User ${nick} was auto-banned for using prohibited language.`);
                return;
            }

            // --- ADMIN COMMANDS HANDLING ---
            if (lowerNick === "nimda" && text.startsWith("/")) {
                const parts = text.trim().split(/\s+/);
                const cmd = parts[0];
                const target = parts.length > 1 ? parts[1] : null; 

                // /freeze and /unfreeze
                if (cmd === "/freeze" || cmd === "/unfreeze") {
                    const action = cmd.substring(1); 
                    const newsstate = action === "freeze";
                    
                    if (isChatFrozen === newsstate) {
                         broadcastChat("SYSTEM", `Chat is already ${isChatFrozen ? 'frozen' : 'unfrozen'}.`);
                    } else {
                        isChatFrozen = newsstate;
                        broadcastChat("SYSTEM", `Admin has ${isChatFrozen ? 'FROZEN' : 'UNFROZEN'} the chat.`);
                    }
                }
                // /ban
                else if (cmd === "/ban" && target) {
                    if(sendAction(target, "ban", 35)) {
                        broadcastChat("SYSTEM", `Admin banned ${target} for 35 minutes.`);
                    } else {
                        broadcastChat("SYSTEM", `User ${target} not found.`);
                    }
                }
                // /kick
                else if (cmd === "/kick" && target) {
                    if(sendAction(target, "kick", 5)) {
                        broadcastChat("SYSTEM", `Admin kicked ${target} for 5 minutes.`);
                    } else {
                        broadcastChat("SYSTEM", `User ${target} not found.`);
                    }
                }
                // /rename
                else if (cmd === "/rename" && target && parts.length > 2) {
                    const newNick = parts[2];
                    let renamed = false;
                    
                    for (let [clientwss, clientNick] of clients.entries()) {
                        if (clientNick === target) {
                            clients.set(clientwss, newNick); 
                            renamed = true;
                            break;
                        }
                    }
                    if (renamed) {
                        broadcastUsers(); 
                        broadcastChat("SYSTEM", `${target} has been renamed to ${newNick} by Admin.`);
                    } else {
                        broadcastChat("SYSTEM", `User ${target} not found for rename.`);
                    }
                }
                // /mute
                else if (cmd === "/mute" && target) {
                    const lowerTarget = target.toLowerCase();
                    if (mutedUsers.has(lowerTarget)) {
                        broadcastChat("SYSTEM", `User ${target} is already muted.`);
                    } else {
                        mutedUsers.add(lowerTarget);
                        broadcastChat("SYSTEM", `Admin muted ${target}.`);
                    }
                }
                // /unmute (NEW EXPLICIT COMMAND)
                else if (cmd === "/unmute" && target) {
                    const lowerTarget = target.toLowerCase();
                    if (mutedUsers.delete(lowerTarget)) { // delete returns true if the element existed
                        broadcastChat("SYSTEM", `Admin unmuted ${target}.`);
                    } else {
                        broadcastChat("SYSTEM", `User ${target} is not currently muted.`);
                    }
                }
                // /highlight
                else if (cmd === "/highlight" && parts.length > 1) {
                    const highlightText = parts.slice(1).join(" ");
                    const highlightData = JSON.stringify({ type: "highlight", text: highlightText });
                    wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(highlightData); });
                }
                // /clear
                else if (cmd === "/clear") {
                    const clearData = JSON.stringify({ type: "clear" });
                    wsss.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(clearData); });
                    broadcastChat("SYSTEM", `Admin cleared the chat history for everyone.`);
                }
                // /unban (manual removal of persistent ban)
                else if (cmd === "/unban" && target) { 
                    if (bannedUsers.delete(target)) {
                        saveBans();
                        broadcastChat("SYSTEM", `Admin manually unbanned ${target}.`);
                    } else {
                        broadcastChat("SYSTEM", `User ${target} is not currently banned.`);
                    }
                }
                else {
                    broadcastChat("SYSTEM", `Admin command error: Unknown command or missing arguments for ${cmd}.`);
                }
                
                return; // Stop processing after an admin command
            }

            // 5. Regular chat broadcast
            broadcastChat(nick, text);
        }
    });

    wss.on('close', () => {
        const closedNick = clients.get(wss);
        clients.delete(wss);
        if (closedNick) {
             broadcastChat("SYSTEM", `${closedNick} has left the chat.`);
             mutedUsers.delete(closedNick.toLowerCase()); // Remove from mute list if they leave
        }
        broadcastUsers();
    });
});