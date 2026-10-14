These public CA certificates are copied from the official Supabase CLI repository:

- https://github.com/supabase/cli/blob/develop/apps/cli-go/internal/gen/types/templates/prod-ca-2021.crt
- https://github.com/supabase/cli/blob/develop/apps/cli-go/internal/gen/types/templates/prod-ca-2025.crt

They are trust anchors for verified TLS connections to Supabase PostgreSQL and its poolers. They are public certificates, not private credentials. The client verifies the chain and hostname; certificate verification is never disabled.
