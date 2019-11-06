const express = require('express');
const routes = require('./routes');
const cors = require('cors');
require('dotenv').config();

class App {
  constructor() {
    this.server = express();
    this.middlewares();
    this.routes();
  }
  middlewares() {
    this.server.use(cors());
    this.server.use(express.json());
  }
  routes() {
    this.server.use('/tarefa', routes);

    this.server.use('/healthcheck', (req, res) => {
      return res.status(200).send();
    });

    this.server.use((req, res) => {
      return res.status(404).json({ error: 'página não encontrada' });
    });

    this.server.use((error, req, res, next) => {
      return res.status(500).json({ error: 'erro interno' });
    });
  }
}

module.exports = new App();