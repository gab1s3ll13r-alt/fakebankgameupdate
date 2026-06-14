import api from './api.js';

const users = {
    search: (q) => api.users.search(q),
    lookup: (iban) => api.users.lookup(iban)
};

export default users;
