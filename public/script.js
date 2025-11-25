document.addEventListener("DOMContentLoaded", () => {
    // FIX: Using wss is correct for Render. We will use location.host dynamically.
    const wss = new WebSocket(`wss://${location.host}`);

    const messagesDiv = document.getElementById("messages");
    // --- FIX 1: Correct ID for User List ---
    const usersDiv = document.getElementById("active-users"); 
    
    const nameInput = document.getElementById("nameInput");
    const msgInput = document.getElementById("msgInput");
    const sendBtn = document.getElementById("sendBtn");
    // --- FIX 2: Correct ID for Suggestions ---
    const suggestionsDiv = document.getElementById("suggestions");

    // Updated list to show explicit /mute and /unmute commands
    const adminCommands = [
        "/kick [name]",
        "/ban [name]",
        "/rename [old] [new]",
        "/highlight [message]",
        "/mute [name]",  
        "/unmute [name]",
        "/unban [name]",
        "/clear",
        "/freeze",   
        "/unfreeze"  
    ];

    let myNick = null;

    // --- Nickname Setup ---
    function setNick() {
        if (!myNick) {
            myNick = nameInput.value.trim() || "anon";
            nameInput.disabled = true;
            wss.send(JSON.stringify({ type: "nick", nick: myNick }));
            
            if (myNick.toLowerCase() === "nimda") {
                if (suggestionsDiv) {
                    suggestionsDiv.style.display = "block";
                    suggestionsDiv.innerHTML = adminCommands.map(c => `<div>${c}</div>`).join("");
                }
            }
        }
    }
    nameInput.addEventListener("keydown", e => { if (e.key === "Enter") setNick(); });
    nameInput.addEventListener("blur", setNick);

    suggestionsDiv.addEventListener("click", e => {
        if (e.target.tagName === "DIV") {
            let text = e.target.textContent;
            text = text.replace(/\[\w+\]/g, '').trim(); 
            msgInput.value = text;
            msgInput.focus();
        }
    });

    // --- Send Message ---
    function sendMessage() {
        if (!myNick || wss.readyState !== WebSocket.OPEN) return; 
        
        const text = msgInput.value.trim();
        if (!text) return;

        wss.send(JSON.stringify({ type: "chat", nick: myNick, text }));
        msgInput.value = "";
        msgInput.focus();
    }
    sendBtn.addEventListener("click", sendMessage);
    msgInput.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });

    // --- Receive Messages ---
    wss.addEventListener("message", event => {
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        if (data.type === "error") {
            console.error(`Error: ${data.message}`);
            if (!data.message.includes("banned")) {
                nameInput.disabled = false;
                nameInput.focus();
                myNick = null;
                if (suggestionsDiv) {
                    suggestionsDiv.style.display = "none";
                }
            }
            return;
        }

        if (data.type === "users") {
            if (usersDiv) {
                const uniqueUsers = Array.from(new Set(data.users));

                usersDiv.innerHTML = uniqueUsers
                    .map(u => u.toLowerCase() === "nimda" ? `<div class="admin-user">ADMIN</div>` : `<div>${u}</div>`)
                    .join("");
            }
            return;
        }
        
        if (data.type === "clear") {
            messagesDiv.innerHTML = '';
        }

        // System messages must be handled here.
        if (data.type === "chat" && data.nick === "SYSTEM") {
            const div = document.createElement("div");
            div.className = "system"; 
            div.textContent = `*** ${data.text} ***`;
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            return;
        }

        // REGULAR CHAT
        if (data.type === "chat") {
            const div = document.createElement("div");
            
            if (data.nick.toLowerCase() === "nimda") {
                 div.classList.add("adminMsg");
            } else {
                div.className = "message";
            }
            
            const timestampSpan = `<span class="timestamp">${data.timestamp}</span>`;

            const displayName = data.nick.toLowerCase() === "nimda" ? "ADMIN" : data.nick;
            div.innerHTML = `[${displayName}]: ${data.text} ${timestampSpan}`;
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            return;
        }

        // BAN/KICK (Client-side enforcement)
        if (data.type === "ban" || data.type === "kick") {
            const reason = data.type === "ban" ? "banned" : "kicked";
            const duration = data.minutes;
            
            const notificationDiv = document.createElement("div");
            notificationDiv.className = "system action-message";
            notificationDiv.textContent = `!!! You have been temporarily ${reason} for ${duration} minutes. !!!`;
            messagesDiv.appendChild(notificationDiv);
            
            msgInput.disabled = true;
            sendBtn.disabled = true;
            
            setTimeout(() => {
                msgInput.disabled = false;
                sendBtn.disabled = false;
                const reenableDiv = document.createElement("div");
                reenableDiv.className = "system";
                reenableDiv.textContent = `*** You can chat again. ***`;
                messagesDiv.appendChild(reenableDiv);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }, duration * 60 * 1000); 
            return;
        }

        // HIGHLIGHT
        if (data.type === "highlight") {
            const div = document.createElement("div");
            div.className = "highlight";
            div.textContent = `*** ANNOUNCEMENT: ${data.text} ***`;
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            return;
        }
    });
});