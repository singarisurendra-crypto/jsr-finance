import { pgTable, text, integer, doublePrecision, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * JSR Finance - Enterprise Modular Monolith Drizzle ORM Schema (PostgreSQL 16 + pgvector)
 * Single authority for database schema, foreign key relations, and cascade operations.
 */

// 1. Users & Operator Whitelist Gate
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  role: text('role').default('operator').notNull(),
  isWhitelisted: boolean('is_whitelisted').default(true).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2. Customers Master Registry
export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  customerNumber: integer('customer_number').notNull().unique(),
  fullName: text('full_name').notNull(),
  mobile: text('mobile'),
  area: text('area'),
  address: text('address'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 3. Multi-Loan Accounts
export const loans = pgTable('loans', {
  id: text('id').primaryKey(),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  loanNumber: integer('loan_number').notNull(),
  givenAmount: doublePrecision('given_amount').notNull(),
  totalRepayable: doublePrecision('total_repayable').notNull(),
  instalmentAmount: doublePrecision('instalment_amount').notNull(),
  totalInstalments: integer('total_instalments').notNull(),
  frequency: text('frequency').default('Weekly').notNull(),
  profitMarginPct: doublePrecision('profit_margin_pct').default(4.0).notNull(),
  disbursedDate: text('disbursed_date').notNull(),
  status: text('status').default('active').notNull(), // active, completed, written_off
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 4. Collections
export const collections = pgTable('collections', {
  id: text('id').primaryKey(),
  loanId: text('loan_id')
    .notNull()
    .references(() => loans.id, { onDelete: 'cascade' }),
  customerId: text('customer_id')
    .notNull()
    .references(() => customers.id, { onDelete: 'cascade' }),
  instalmentNumber: integer('instalment_number').notNull(),
  amountPaid: doublePrecision('amount_paid').notNull(),
  paidAt: text('paid_at').notNull(),
  receiptNumber: text('receipt_number').notNull().unique(),
  notes: text('notes'),
  status: text('status').default('verified').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 5. Transactional Audit Lineage (Pitfall #10 & #11)
export const collectionLineage = pgTable('collection_lineage', {
  id: text('id').primaryKey(),
  collectionId: text('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  loanId: text('loan_id')
    .notNull()
    .references(() => loans.id, { onDelete: 'cascade' }),
  principalPortion: doublePrecision('principal_portion').notNull(),
  profitPortion: doublePrecision('profit_portion').notNull(),
  remainingBalance: doublePrecision('remaining_balance').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 6. Audit Trail
export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  performedBy: text('performed_by').notNull(),
  payload: text('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const customerRelations = relations(customers, ({ many }) => ({
  loans: many(loans),
  collections: many(collections),
}));

export const loanRelations = relations(loans, ({ one, many }) => ({
  customer: one(customers, {
    fields: [loans.customerId],
    references: [customers.id],
  }),
  collections: many(collections),
  lineage: many(collectionLineage),
}));

export const collectionRelations = relations(collections, ({ one }) => ({
  loan: one(loans, {
    fields: [collections.loanId],
    references: [loans.id],
  }),
  customer: one(customers, {
    fields: [collections.customerId],
    references: [customers.id],
  }),
}));
