import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',workers:1,timeout:60000,use:{baseURL:'http://127.0.0.1:3199',headless:true,channel:'msedge',trace:'retain-on-failure',screenshot:'only-on-failure'},webServer:{command:'node e2e/server.mjs',url:'http://127.0.0.1:3199/api/health',reuseExistingServer:false,timeout:30000}});
