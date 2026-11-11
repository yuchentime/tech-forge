import { Body, Controller, Get, Put } from '@nestjs/common';
import { SaveSettingsInput } from './settings.dto';
import { SettingsService } from './settings.service';

/** Exposes authenticated local settings read and write operations. */
@Controller('settings')
export class SettingsController {
  /** Injects the local file owner for settings reads and writes. */
  constructor(private readonly settings: SettingsService) {}

  /** Returns DeepSeek fields, Key presence and style text for the local settings page. */
  @Get()
  getSettings() {
    return this.settings.getSettings();
  }

  /** Persists the submitted DeepSeek and style preference settings. */
  @Put()
  saveSettings(@Body() input: SaveSettingsInput) {
    return this.settings.saveSettings(input);
  }
}
