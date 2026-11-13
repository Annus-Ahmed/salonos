CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sku text NOT NULL UNIQUE,
 name text NOT NULL,
 retail_price_minor bigint NOT NULL CHECK (retail_price_minor >= 0),
 units integer NOT NULL DEFAULT 0 CHECK (units >= 0),
 value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id uuid NOT NULL REFERENCES products(id),
 kind text NOT NULL CHECK (kind IN ('purchase','retail','usage')),
 date date NOT NULL,
 quantity integer NOT NULL CHECK (quantity > 0),
 cost_minor bigint NOT NULL CHECK (cost_minor >= 0),
 sale_minor bigint NOT NULL DEFAULT 0 CHECK (sale_minor >= 0),
 method text NOT NULL,
 note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now()
);
