const fs = require('fs');
const path = require('path');

function editSessionEnd() {
    let content = fs.readFileSync('src/cli/session.ts', 'utf8');
    // For session end:
    // instead of fs.readdirSync(sessionsDir).forEach(f => { if(f.endsWith('.md')) fs.unlinkSync... })
    // wait, I need to look at what session end actually looks like. Let's not blind replace it.
}
editSessionEnd();
