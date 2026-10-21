import { Command, Help, Option } from 'commander';
import { localizeCommanderError } from './locale-errors.js';
import { getCliLocale, setCliLocale, text } from './i18n.js';

/** Use the parsed global option rather than scanning argv or changing console. */
export function configureCliLocale(program: Command): void {
  const selectLocale = (command: Command) => {
    setCliLocale(command.optsWithGlobals().lang === 'ja' ? 'ja' : 'en');
  };
  program.addOption(new Option('--lang <language>', 'Language for help and messages (en or ja)')
    .choices(['en', 'ja']).env('BUTTERBASE_LANG').default('en'));
  program.configureOutput({
    outputError(output, write) {
      selectLocale(program);
      write(localizeCommanderError(output));
    },
  });
  program.hook('preAction', (_, action) => selectLocale(action));
  program.configureHelp({
    commandDescription: command => text(command.description()),
    subcommandDescription: command => text(command.summary() || command.description()),
    optionDescription: option => new Help().optionDescription(
      Object.assign(Object.create(option), { description: text(option.description) }),
    ),
    argumentDescription: argument => new Help().argumentDescription(
      Object.assign(Object.create(argument), { description: text(argument.description ?? '') }),
    ),
    formatHelp(command, helper) {
      selectLocale(command);
      const help = Help.prototype.formatHelp.call(helper, command, helper);
      if (getCliLocale() === 'en') return help;
      return help.replace(/^(Usage:|Arguments:|Options:|Commands:)/gm, label => ({
        'Usage:': '使い方：', 'Arguments:': '引数：', 'Options:': 'オプション：', 'Commands:': 'コマンド：',
      })[label] ?? label);
    },
  });
}
