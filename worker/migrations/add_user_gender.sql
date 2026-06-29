-- Owner gender for receptionist pronouns ("can I take a message for him/her/them?")
-- and profile completeness. NULL until the user picks one in the profile screen.
-- Values: 'male' | 'female' | 'other' (client-validated).
ALTER TABLE users ADD COLUMN gender TEXT;
