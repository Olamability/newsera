require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

console.log("🚀 Script started");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

console.log("🔌 Supabase client created");

async function makeAdmin() {
    console.log("⚙️ Updating user...");

    const { data, error } = await supabase.auth.admin.updateUserById(
        '987850d8-65cd-47c2-a7af-9786bb34b1f6',
        {
            app_metadata: {
                role: 'admin',
            },
        }
    );

    console.log("📦 Response:", { data, error });
}

makeAdmin();