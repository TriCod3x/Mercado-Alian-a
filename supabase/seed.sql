-- Categorias padrão — rode SOMENTE numa instalação nova (sem migrar dados
-- do SQLite). Se for migrar, NÃO rode: as categorias virão do banco antigo.
INSERT INTO categories (name)
VALUES ('Mercearia'), ('Bebidas'), ('Limpeza'), ('Higiene'), ('Hortifruti'), ('Padaria'), ('Outros')
ON CONFLICT ((lower(name))) DO NOTHING;
