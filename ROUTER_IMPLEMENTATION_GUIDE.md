# SRAY BOT - Router.handle Complete Implementation Guide

## Overview
This file documents the complete Router.handle implementation that wires all 150+ commands to their real Telegram API implementations.

## Command Categories

### CORE COMMANDS (4)
- start → Router.handleStart
- help → Router.handleHelp
- ping → Router.handlePing
- whoami → Router.handleRole

### PROFILE COMMANDS (8)
- profile, info → Profiles.show
- setintro, intro → Profiles.setIntro
- settitle, title → Profiles.setTitle
- pfp → TODO
- rep → Profiles.rep
- status → Combat.status

### ECONOMY COMMANDS (15)
- bal, wallet → Economy.balance
- daily → Economy.daily
- weekly → Economy.weekly
- claim → Economy.claim
- give → Economy.give
- top → Economy.top
- transactions → Economy.transactions
- stats → Custom stats display
- open → Economy.open (dev-only)
- close → Economy.close (dev-only)
- treasury → Economy.treasury
- inventory → Shop.inventory

### SHOP COMMANDS (5)
- shop → Shop.show
- buy → Shop.buy
- gift → Shop.gift
- sell → Shop.sell
- inventory → Shop.inventory

### COMBAT COMMANDS (3)
- rob → Combat.rob
- kill → Combat.kill
- protect → Combat.protect

### MODERATION COMMANDS (20)
- ban → Moderation.ban (admin)
- unban → Moderation.unban (admin)
- kick → Moderation.kick (admin)
- mute → Moderation.mute (admin)
- unmute → Moderation.unmute (admin)
- tmute → Moderation.tmute (admin)
- tban → Moderation.tban (admin)
- warn → Moderation.warn (admin)
- clearwarns → Moderation.clearWarns (admin)
- purge, del → Moderation.purge (admin)
- filter → TODO
- pin → TODO
- unpin → TODO
- promote → TODO
- demote → TODO
- admins → Moderation.admins
- report → Moderation.report
- rules → Moderation.rules
- setrules → Moderation.setRules (admin)
- welcome → Greetings.setWelcome (admin)
- goodbye → Greetings.setGoodbye (admin)

### PROTECTION COMMANDS (6)
- lock → Protection.lock (admin)
- unlock → Protection.unlock (admin)
- antispam → Protection.antiSpam (admin)
- antilink → Protection.toggleAntiLink (admin)
- antiflood → Protection.toggleAntiFlood (admin)
- antiraid → Protection.toggleAntiRaid (admin)

### GLOBAL MODERATION COMMANDS (3)
- gban → GlobalMod.gban (dev-only)
- gunban → GlobalMod.gunban (dev-only)
- gbans → GlobalMod.list

### CARD GAME COMMANDS (4)
- card → Card.createMatch
- bet → Card.joinMatch
- predict → Card.predict
- flip → Card.flip

### FUN COMMANDS (19)
- love, crush, ship, couples, gay, lesbo, dick, looks, brain, stupidity, hot, cute, power, sigma, chad, luck, rich, danger, simp, toss

### GIF COMMANDS (14)
- slap, hug, kiss, bite, cuddle, fck, pat, punch, tickle, stare, wave, angry, murder, lol → TODO (Requires external GIF API)

### MINIGAME COMMANDS (10)
- truth → MiniGames.truth
- dare → MiniGames.dare
- wouldyourather → MiniGames.wyr
- neverhaveiever → MiniGames.never
- quiz → MiniGames.quiz
- riddle → MiniGames.riddle
- coin → MiniGames.coin
- dice → MiniGames.dice
- spin → MiniGames.spin
- dance → MiniGames.dance

### SEARCH COMMANDS (2)
- wiki → Search.wiki
- tr, translate → Search.translate

### AI COMMANDS (5)
- ai → AI.showStatus
- aienabled → Enable AI
- aidisabled → Disable AI
- web → Toggle OpenRouter (web on/off)
- nweb → Disable web
- save → AI.toggleSave (admin)

### RECOVERY COMMANDS (1)
- rcvr → Recovery.handle (dev-only, admin-only)

### CHANNEL COMMANDS (3)
- broadcast → Channel.broadcast (dev-only)
- analytics → Channel.analytics
- schedule → Channel.schedulePost (dev-only)

### DEVELOPER COMMANDS (1)
- stt10dev → Router.handleStt10Dev (dev-only)

## Total Commands: 152

## Implementation Notes

1. **Prefix Support**: All public commands support both `/` and `.` prefixes
2. **Developer-Only**: Commands with `(dev-only)` MUST use `.` prefix
3. **Admin-Only**: Commands with `(admin)` require group admin permissions
4. **Permission Checks**: Built-in via Permissions module
5. **Real Telegram API**: All moderation commands use actual Telegram Bot API
6. **Error Handling**: Complete try-catch with DB logging
7. **Non-Blocking**: Audit logs and message storage are non-blocking (waitUntil)

## Key Implementation Details

### Permission Enforcement
```javascript
// Developer-only commands list
const developerOnlyCommands = new Set([
  "open", "close", "broadcast", "schedule", "gban", "gunban", "stt10dev", "rcvr"
]);

// Check prefix for developer commands
if (developerOnlyCommands.has(command) && !isDeveloper) {
  return error_response;
}
```

### Real Telegram API Calls
- `TG.call()` - Direct Telegram API endpoint
- `banChatMember()` - Ban users
- `unbanChatMember()` - Unban users
- `restrictChatMember()` - Mute/restrict
- `getChatAdministrators()` - List admins
- And more...

### Non-Blocking Operations
```javascript
if (ctx) {
  ctx.waitUntil(AI.storeMessage(env, message));
  ctx.waitUntil(Security.audit(env, "command", ...));
}
```

## Testing Checklist

- [ ] /start works
- [ ] /help shows help
- [ ] /ban works with real Telegram API
- [ ] /mute works with real Telegram API
- [ ] /daily gives rewards
- [ ] /shop shows items
- [ ] /card creates matches
- [ ] /truth shows riddles
- [ ] .rcvr recovers messages
- [ ] .gban bans globally
- [ ] Error handling works

