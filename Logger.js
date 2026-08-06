const colors = require("colors");
const moment = require("moment");

class Logger {
    static opensea(args) {
        return console.log(colors.green(`[${moment(Date.now()).format("hh:mm")}] Opensea log: ${args}`));
    }

    static info(args) {
        return console.log(colors.green(`[${moment(Date.now()).format("hh:mm")}] ${args}`));
    }

    static check(args) {
        return console.log(colors.blue(`[${moment(Date.now()).format("hh:mm")}] ${args}`));
    }

    static success(args) {
        return console.log(colors.cyan(`[${moment(Date.now()).format("hh:mm")}] ${args}`));
    }

    static warn(args) {
        return console.log(colors.yellow(`[${moment(Date.now()).format("hh:mm")}] ${args}`));
    }

    static err(args) {
        return console.log(colors.red(`[${moment(Date.now()).format("hh:mm")}] ${args}`));
    }

}

module.exports = Logger;