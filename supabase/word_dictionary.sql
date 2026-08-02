create table if not exists public.word_dictionary (
  word text primary key,
  first_syllable text generated always as (left(word, 1)) stored,
  last_syllable text generated always as (right(word, 1)) stored,
  created_at timestamptz not null default now()
);

create index if not exists word_dictionary_first_syllable_idx
  on public.word_dictionary (first_syllable);

alter table public.word_dictionary enable row level security;

drop policy if exists "public can read word dictionary" on public.word_dictionary;
create policy "public can read word dictionary"
  on public.word_dictionary for select
  to anon, authenticated
  using (true);
