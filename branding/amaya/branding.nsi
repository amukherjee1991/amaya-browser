# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# NSIS branding defines for Amaya builds (Windows is Phase 3; kept so the
# branding directory is complete). URLs are .invalid placeholders, see
# branding/README.md.

# BrandFullNameInternal is used for some registry and file system values
# instead of BrandFullName and typically should not be modified.
!define BrandFullNameInternal "Amaya Browser"
!define BrandFullName         "Amaya Browser"
!define CompanyName           "Amaya"
!define URLInfoAbout          "https://amaya-browser.invalid/"
!define HelpLink              "https://amaya-browser.invalid/support/"

!define URLStubDownloadX86 "https://amaya-browser.invalid/download/?os=win&lang=${AB_CD}"
!define URLStubDownloadAMD64 "https://amaya-browser.invalid/download/?os=win64&lang=${AB_CD}"
!define URLStubDownloadAArch64 "https://amaya-browser.invalid/download/?os=win64-aarch64&lang=${AB_CD}"
!define URLManualDownload "https://amaya-browser.invalid/download/?installer_lang=${AB_CD}"
!define URLSystemRequirements "https://amaya-browser.invalid/system-requirements/"
!define Channel "release"

# The installer's certificate name and issuer expected by the stub installer.
# Placeholders until Amaya has a Windows code-signing certificate.
!define CertNameDownload   "Amaya"
!define CertIssuerDownload "Amaya"

# Dialog units are used so the UI displays correctly with the system's DPI
# settings.
!define PROFILE_CLEANUP_LABEL_TOP "35u"
!define PROFILE_CLEANUP_LABEL_LEFT "0"
!define PROFILE_CLEANUP_LABEL_WIDTH "100%"
!define PROFILE_CLEANUP_LABEL_HEIGHT "80u"
!define PROFILE_CLEANUP_LABEL_ALIGN "center"
!define PROFILE_CLEANUP_CHECKBOX_LEFT "center"
!define PROFILE_CLEANUP_CHECKBOX_WIDTH "100%"
!define PROFILE_CLEANUP_BUTTON_LEFT "center"
!define INSTALL_BLURB_TOP "137u"
!define INSTALL_BLURB_WIDTH "60u"
!define INSTALL_FOOTER_TOP "-48u"
!define INSTALL_FOOTER_WIDTH "250u"
!define INSTALL_INSTALLING_TOP "70u"
!define INSTALL_INSTALLING_LEFT "0"
!define INSTALL_INSTALLING_WIDTH "100%"
!define INSTALL_PROGRESS_BAR_TOP "112u"
!define INSTALL_PROGRESS_BAR_LEFT "20%"
!define INSTALL_PROGRESS_BAR_WIDTH "60%"
!define INSTALL_PROGRESS_BAR_HEIGHT "12u"

!define PROFILE_CLEANUP_CHECKBOX_TOP_MARGIN "20u"
!define PROFILE_CLEANUP_BUTTON_TOP_MARGIN "20u"
!define PROFILE_CLEANUP_BUTTON_X_PADDING "40u"
!define PROFILE_CLEANUP_BUTTON_Y_PADDING "4u"

# Font settings that can be customized for each channel
!define INSTALL_HEADER_FONT_SIZE 28
!define INSTALL_HEADER_FONT_WEIGHT 400
!define INSTALL_INSTALLING_FONT_SIZE 28
!define INSTALL_INSTALLING_FONT_WEIGHT 400

# UI Colors that can be customized for each channel (NSIS uses 0xRRGGBB)
!define COMMON_TEXT_COLOR 0xF4F6FB
!define COMMON_BACKGROUND_COLOR 0x141A3A
!define INSTALL_INSTALLING_TEXT_COLOR 0xF4F6FB
