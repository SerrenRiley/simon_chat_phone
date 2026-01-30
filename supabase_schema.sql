-- Supabase schema for cloud sync
-- Requires pgcrypto extension for gen_random_uuid
create extension if not exists pgcrypto;

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  preview text,
  character_id text,
  api_profile_id text,
  is_deleted boolean default false,
  updated_at timestamptz default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null,
  content text not null,
  model text,
  tokens jsonb,
  is_deleted boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute procedure public.set_updated_at();

create trigger messages_set_updated_at
before update on public.messages
for each row execute procedure public.set_updated_at();

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

create policy "conversations_read" on public.conversations
for select using (auth.uid() = user_id);

create policy "conversations_write" on public.conversations
for insert with check (auth.uid() = user_id);

create policy "conversations_update" on public.conversations
for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "messages_read" on public.messages
for select using (auth.uid() = user_id);

create policy "messages_write" on public.messages
for insert with check (auth.uid() = user_id);

create policy "messages_update" on public.messages
for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
