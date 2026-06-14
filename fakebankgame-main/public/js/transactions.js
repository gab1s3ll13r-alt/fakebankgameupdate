import api from './api.js';

const transactions = {
    transfer: (recipientId, amount, description) =>
        api.transactions.transfer(recipientId, amount, description),

    history: (page, limit) =>
        api.transactions.history(page, limit),

    details: (id) =>
        api.transactions.get(id),

    summary: (days) =>
        api.transactions.summary(days)
};

export default transactions;
