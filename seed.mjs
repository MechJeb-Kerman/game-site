
import { migrate, db } from 'file:///D:/CODE/undefined/temp/og-e2e-yucM8N/site/src/db.js';
import { seasonOf } from 'file:///D:/CODE/undefined/temp/og-e2e-yucM8N/site/src/elo.js';
import { SLUGS } from 'file:///D:/CODE/undefined/temp/og-e2e-yucM8N/site/src/rules/index.js';
migrate();
const NOW = Date.now();
db.exec("INSERT INTO categories (slug,name,icon,sort) VALUES ('e2e','E2E','🎯',1)");
const cat = Number(db.prepare("SELECT id FROM categories WHERE slug='e2e'").get().id);
const g = db.prepare('INSERT INTO games (slug,title,category_id,game_url,status,accent,accent2) VALUES (?,?,?,?,1,?,?)');
for (const [i, s] of [SLUGS[0], SLUGS[1], 'e2e-extra'].entries()) g.run(s, 'E2E ' + i, cat, '/g/' + s, '#102030', '#302010');
const mv = JSON.stringify([{ seq: 1, seat: 0, move: 'h8' }, { seq: 2, seat: 1, move: 'i9' }]);
db.prepare('INSERT INTO play_replays (game,room_code,host_name,guest_name,result,move_count,moves,plays,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(SLUGS[0], 'E2E001', '真机甲', '真机乙', 'host', 2, mv, 7, NOW - 500);
db.prepare('INSERT INTO users (username,display_name,pass_hash,pass_salt) VALUES (?,?,?,?)').run('e2euser', '真机用户', 'x', 'y');
const uid = Number(db.prepare("SELECT id FROM users WHERE username='e2euser'").get().id);
db.prepare('INSERT INTO player_ratings (user_id,game,season,rating,games,wins,losses,draws,peak,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  .run(String(uid), SLUGS[0], seasonOf(NOW), 1611, 5, 4, 1, 0, 1611, NOW);
console.log('SEEDED replay_id=' + db.prepare('SELECT id FROM play_replays').get().id);
db.close();
