import { loadConfig } from '../config/index.js';
import { DatabaseService } from './index.js';

const config = loadConfig();
const db = new DatabaseService(config);

console.log('Running database migrations...');
db.migrate();
console.log('Database migrations completed.');

db.close();